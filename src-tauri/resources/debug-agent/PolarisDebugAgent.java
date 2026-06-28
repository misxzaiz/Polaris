// PolarisDebugAgent — lightweight JDI debug agent for Polaris.
//
// Attaches to a running JVM via JDWP (SocketAttach) and bridges a tiny
// line protocol to structured JSON, so the Rust/JS side never has to parse
// jdb text output.
//
//   stdin  (one command per line, space-separated):
//     setBreakpoint <id> <fqcn> <line>
//     removeBreakpoint <id>
//     continue
//     stepOver | stepInto | stepOut
//     getChildren <objectId>
//     disconnect
//
//   stdout (one JSON object per line, ASCII-safe):
//     {"event":"ready"}
//     {"event":"breakpoint","id":..,"verified":bool,"line":..,"message":..}
//     {"event":"stopped","reason":"breakpoint|step","thread":..,"frames":[..],"variables":[..]}
//     {"event":"continued"}
//     {"event":"children","objectId":N,"variables":[..]}
//     {"event":"terminated"}
//     {"event":"error","message":..}
//     {"event":"log","message":..}
//
// Run (no compile step needed on JDK 11+):
//   java --source 17 --add-modules jdk.jdi PolarisDebugAgent.java <port>
//
// Notes on threading: stdin commands and JDI events run on two threads.
// com.sun.tools.jdi mirror operations are internally synchronized; shared
// agent state is guarded explicitly.

import com.sun.jdi.*;
import com.sun.jdi.connect.*;
import com.sun.jdi.event.*;
import com.sun.jdi.request.*;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

public class PolarisDebugAgent {

    static VirtualMachine vm;
    static EventRequestManager erm;
    static final PrintStream OUT = new PrintStream(System.out, true, StandardCharsets.UTF_8);

    // Pending/active breakpoints keyed by client id.
    static final Map<String, Bp> breakpoints = new ConcurrentHashMap<>();
    // Object id -> reference, valid only while suspended (cleared on resume).
    static final Map<Long, ObjectReference> objCache = new HashMap<>();
    static volatile ThreadReference suspendedThread;
    static volatile boolean alive = true;

    static final class Bp {
        final String id, fqcn; final int line;
        BreakpointRequest req;
        Bp(String id, String fqcn, int line){ this.id=id; this.fqcn=fqcn; this.line=line; }
    }

    public static void main(String[] args) {
        if (args.length < 1) { emitError("missing port argument"); return; }
        String port = args[0];
        try {
            vm = attach(port);
        } catch (Exception e) {
            emitError("attach failed on port " + port + ": " + e);
            return;
        }
        erm = vm.eventRequestManager();
        emit("{\"event\":\"ready\"}");

        Thread cmd = new Thread(PolarisDebugAgent::commandLoop, "polaris-cmd");
        cmd.setDaemon(true);
        cmd.start();

        eventLoop();
    }

    // ----- attach -----
    static VirtualMachine attach(String port) throws Exception {
        AttachingConnector connector = null;
        for (AttachingConnector c : Bootstrap.virtualMachineManager().attachingConnectors()) {
            if ("com.sun.jdi.SocketAttach".equals(c.name())) { connector = c; break; }
        }
        if (connector == null) throw new IllegalStateException("no SocketAttach connector");
        Map<String, Connector.Argument> a = connector.defaultArguments();
        a.get("hostname").setValue("localhost");
        a.get("port").setValue(port);
        return connector.attach(a);
    }

    // ----- stdin command loop -----
    static void commandLoop() {
        try (BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
            String line;
            while (alive && (line = in.readLine()) != null) {
                line = line.trim();
                if (line.isEmpty()) continue;
                try { dispatch(line); }
                catch (Exception e) { emitError("command failed [" + line + "]: " + e); }
            }
        } catch (Exception e) {
            emitError("stdin closed: " + e);
        }
    }

    static void dispatch(String line) {
        String[] p = line.split("\\s+");
        switch (p[0]) {
            case "setBreakpoint":    setBreakpoint(p[1], p[2], Integer.parseInt(p[3])); break;
            case "removeBreakpoint": removeBreakpoint(p[1]); break;
            case "continue":         resume(); break;
            case "stepOver":         step(StepRequest.STEP_OVER); break;
            case "stepInto":         step(StepRequest.STEP_INTO); break;
            case "stepOut":          step(StepRequest.STEP_OUT); break;
            case "getChildren":      getChildren(Long.parseLong(p[1])); break;
            case "disconnect":       disconnect(); break;
            default: emitError("unknown command: " + p[0]);
        }
    }

    // ----- breakpoints -----
    static synchronized void setBreakpoint(String id, String fqcn, int line) {
        Bp bp = new Bp(id, fqcn, line);
        breakpoints.put(id, bp);
        // Bind now if the class is already loaded; otherwise wait for ClassPrepare.
        List<ReferenceType> loaded = vm.classesByName(fqcn);
        if (!loaded.isEmpty()) {
            boolean ok = false;
            for (ReferenceType rt : loaded) ok |= bind(bp, rt);
            if (!ok) emitBreakpoint(id, false, line, "no executable code at line " + line);
        } else {
            ensureClassPrepare(fqcn);
            emitBreakpoint(id, false, line, "deferred (class not loaded)");
        }
    }

    static final Set<String> cprArmed = new HashSet<>();
    static void ensureClassPrepare(String fqcn) {
        if (!cprArmed.add(fqcn)) return;
        ClassPrepareRequest cpr = erm.createClassPrepareRequest();
        cpr.addClassFilter(fqcn);
        cpr.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
        cpr.enable();
    }

    static boolean bind(Bp bp, ReferenceType rt) {
        try {
            List<Location> locs = rt.locationsOfLine(bp.line);
            if (locs.isEmpty()) return false;
            BreakpointRequest req = erm.createBreakpointRequest(locs.get(0));
            req.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
            req.enable();
            bp.req = req;
            emitBreakpoint(bp.id, true, bp.line, null);
            return true;
        } catch (AbsentInformationException e) {
            emitBreakpoint(bp.id, false, bp.line, "no line-number info (compile with -g)");
            return false;
        }
    }

    static synchronized void removeBreakpoint(String id) {
        Bp bp = breakpoints.remove(id);
        if (bp != null && bp.req != null) erm.deleteEventRequest(bp.req);
    }

    // ----- execution control -----
    static synchronized void resume() {
        ThreadReference t = suspendedThread;
        clearSuspendState();
        if (t != null) t.resume(); else vm.resume();
        emit("{\"event\":\"continued\"}");
    }

    static synchronized void step(int depth) {
        ThreadReference t = suspendedThread;
        if (t == null) { emitError("cannot step: not suspended"); return; }
        // Only one active StepRequest per thread is allowed.
        for (StepRequest sr : new ArrayList<>(erm.stepRequests()))
            if (sr.thread().equals(t)) erm.deleteEventRequest(sr);
        StepRequest sr = erm.createStepRequest(t, StepRequest.STEP_LINE, depth);
        sr.addCountFilter(1);
        sr.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
        sr.enable();
        clearObjCache();
        suspendedThread = null;
        t.resume();
    }

    static void clearSuspendState() { clearObjCache(); suspendedThread = null; }
    static synchronized void clearObjCache() { objCache.clear(); }

    static void disconnect() {
        alive = false;
        try { if (vm != null) vm.dispose(); } catch (Exception ignore) {}
        emit("{\"event\":\"terminated\"}");
        System.exit(0);
    }

    // ----- JDI event loop -----
    static void eventLoop() {
        EventQueue q = vm.eventQueue();
        while (alive) {
            EventSet set;
            try { set = q.remove(); }
            catch (VMDisconnectedException e) { emit("{\"event\":\"terminated\"}"); break; }
            catch (InterruptedException e) { continue; }

            boolean resumeSet = true;
            for (Event ev : set) {
                if (ev instanceof ClassPrepareEvent) {
                    onClassPrepare((ClassPrepareEvent) ev);
                } else if (ev instanceof BreakpointEvent) {
                    onStop(((BreakpointEvent) ev).thread(), "breakpoint"); resumeSet = false;
                } else if (ev instanceof StepEvent) {
                    StepEvent se = (StepEvent) ev;
                    for (StepRequest sr : new ArrayList<>(erm.stepRequests()))
                        if (sr.thread().equals(se.thread())) erm.deleteEventRequest(sr);
                    onStop(se.thread(), "step"); resumeSet = false;
                } else if (ev instanceof VMDeathEvent || ev instanceof VMDisconnectEvent) {
                    emit("{\"event\":\"terminated\"}"); alive = false;
                }
            }
            if (resumeSet && alive) { try { set.resume(); } catch (Exception ignore) {} }
        }
    }

    static synchronized void onClassPrepare(ClassPrepareEvent ev) {
        ReferenceType rt = ev.referenceType();
        for (Bp bp : breakpoints.values())
            if (bp.req == null && bp.fqcn.equals(rt.name())) bind(bp, rt);
    }

    // ----- stop: build frames + top-frame variables -----
    static synchronized void onStop(ThreadReference t, String reason) {
        suspendedThread = t;
        clearObjCache();
        StringBuilder sb = new StringBuilder();
        sb.append("{\"event\":\"stopped\",\"reason\":\"").append(reason).append("\",");
        sb.append("\"thread\":").append(jstr(t.name())).append(",\"frames\":[");
        try {
            List<StackFrame> frames = t.frames();
            for (int i = 0; i < frames.size(); i++) {
                if (i > 0) sb.append(',');
                Location loc = frames.get(i).location();
                String cn = loc.declaringType().name();
                sb.append("{\"index\":").append(i)
                  .append(",\"class\":").append(jstr(cn))
                  .append(",\"method\":").append(jstr(loc.method().name()))
                  .append(",\"source\":").append(jstr(safeSource(loc)))
                  .append(",\"line\":").append(loc.lineNumber())
                  .append(",\"framework\":").append(isFramework(cn))
                  .append('}');
            }
        } catch (Exception e) { /* frames best-effort */ }
        sb.append("],\"variables\":[");
        try {
            StackFrame top = t.frame(0);
            List<LocalVariable> vars = top.visibleVariables();
            boolean first = true;
            // implicit 'this'
            ObjectReference self = top.thisObject();
            if (self != null) { sb.append(varJson("this", self.referenceType().name(), self)); first = false; }
            for (LocalVariable v : vars) {
                if (!first) sb.append(','); first = false;
                sb.append(varJson(v.name(), v.typeName(), top.getValue(v)));
            }
        } catch (AbsentInformationException e) {
            // no local var info
        } catch (Exception e) { /* best-effort */ }
        sb.append("]}");
        emit(sb.toString());
    }

    // ----- object expansion -----
    static synchronized void getChildren(long objectId) {
        ObjectReference obj = objCache.get(objectId);
        StringBuilder sb = new StringBuilder();
        sb.append("{\"event\":\"children\",\"objectId\":").append(objectId).append(",\"variables\":[");
        if (obj == null) { sb.append("]}"); emit(sb.toString()); return; }
        try {
            boolean first = true;
            if (obj instanceof ArrayReference) {
                ArrayReference arr = (ArrayReference) obj;
                int n = Math.min(arr.length(), 200);
                for (int i = 0; i < n; i++) {
                    if (!first) sb.append(','); first = false;
                    sb.append(varJson("[" + i + "]", "", arr.getValue(i)));
                }
            } else {
                ReferenceType rt = obj.referenceType();
                for (Field f : rt.allFields()) {
                    if (f.isStatic()) continue;
                    if (!first) sb.append(','); first = false;
                    sb.append(varJson(f.name(), f.typeName(), obj.getValue(f)));
                }
            }
        } catch (Exception e) { /* best-effort */ }
        sb.append("]}");
        emit(sb.toString());
    }

    // ----- value formatting -----
    static String varJson(String name, String declaredType, Value v) {
        String type = declaredType, value; long oid = 0; boolean hasChildren = false;
        if (v == null) {
            value = "null"; if (type == null || type.isEmpty()) type = "null";
        } else if (v instanceof StringReference) {
            value = "\"" + ((StringReference) v).value() + "\""; type = "String";
        } else if (v instanceof PrimitiveValue) {
            value = v.toString(); if (type == null || type.isEmpty()) type = v.type().name();
        } else if (v instanceof ArrayReference) {
            ArrayReference a = (ArrayReference) v;
            type = a.referenceType().name();
            value = simpleName(type) + "[" + a.length() + "]";
            oid = a.uniqueID(); hasChildren = a.length() > 0; objCache.put(oid, a);
        } else if (v instanceof ObjectReference) {
            ObjectReference o = (ObjectReference) v;
            type = o.referenceType().name();
            value = simpleName(type) + "@" + o.uniqueID();
            oid = o.uniqueID(); hasChildren = true; objCache.put(oid, o);
        } else {
            value = v.toString();
        }
        return "{\"name\":" + jstr(name) + ",\"type\":" + jstr(simpleName(type))
             + ",\"value\":" + jstr(value) + ",\"hasChildren\":" + hasChildren
             + ",\"objectId\":" + oid + "}";
    }

    static String simpleName(String fqcn) {
        if (fqcn == null) return "";
        int lt = fqcn.indexOf('<');
        String base = lt >= 0 ? fqcn.substring(0, lt) : fqcn;
        int dot = base.lastIndexOf('.');
        return dot >= 0 ? fqcn.substring(dot + 1) : fqcn;
    }

    static boolean isFramework(String cn) {
        return cn.startsWith("java.") || cn.startsWith("javax.") || cn.startsWith("jakarta.")
            || cn.startsWith("jdk.") || cn.startsWith("sun.") || cn.startsWith("com.sun.")
            || cn.startsWith("org.springframework.") || cn.startsWith("org.apache.")
            || cn.startsWith("org.hibernate.") || cn.startsWith("ch.qos.") || cn.startsWith("io.netty.");
    }

    static String safeSource(Location loc) {
        try { return loc.sourceName(); } catch (AbsentInformationException e) { return ""; }
    }

    // ----- output -----
    static void emitBreakpoint(String id, boolean verified, int line, String msg) {
        emit("{\"event\":\"breakpoint\",\"id\":" + jstr(id) + ",\"verified\":" + verified
           + ",\"line\":" + line + ",\"message\":" + jstr(msg) + "}");
    }
    static void emitError(String msg) { emit("{\"event\":\"error\",\"message\":" + jstr(msg) + "}"); }
    static synchronized void emit(String json) { OUT.println(json); OUT.flush(); }

    // Minimal ASCII-safe JSON string encoder.
    static String jstr(String s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n");  break;
                case '\r': b.append("\\r");  break;
                case '\t': b.append("\\t");  break;
                default:
                    if (c < 0x20 || c > 0x7e) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        return b.append('"').toString();
    }
}
