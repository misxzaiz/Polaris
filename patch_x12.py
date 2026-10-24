import re, io

# ============ router/mod.rs ============
p = 'src-tauri/src/services/router/mod.rs'
s = io.open(p, encoding='utf-8').read()

old = "    permission: Box<dyn Permission>,"
new = "    permission: Arc<dyn Permission>,"
assert old in s; s = s.replace(old, new)

old = """    pub fn new(
        broadcaster: Arc<EventAdapter>,
        permission: Box<dyn Permission>,
        storage: Option<Arc<dyn Storage>>,
        audit: Option<Arc<dyn AuditSink>>,
    ) -> Self {"""
new = """    pub fn new(
        broadcaster: Arc<EventAdapter>,
        permission: Arc<dyn Permission>,
        storage: Option<Arc<dyn Storage>>,
        audit: Option<Arc<dyn AuditSink>>,
    ) -> Self {"""
assert old in s; s = s.replace(old, new)
s = s.replace("/// - `permission`: 权限裁决（可用 `StaticPermission`）",
              "/// - `permission`: 权限裁决（Arc 共享：dispatch 注入 RealContext 供能力内二次裁决）")

old = """    fn register_handle(&self, cap: Box<dyn Capability>) -> Result<CapabilityHandle, String> {
        let handle = self.next_handle.fetch_add(1, Ordering::SeqCst);
        let mut handles = self.handles.write().unwrap();
        handles.insert(handle, Arc::from(cap));
        Ok(handle)
    }
}"""
new = """    fn register_handle(&self, cap: Box<dyn Capability>) -> Result<CapabilityHandle, String> {
        // X12（2026-10-24 审计）：拒绝同 id 重复注册——双注册后 dispatch 遍历
        // HashMap 取序不定，分派不可预测。装配点全部 `let _ =` 忽略错误，
        // 重复注册静默变为「保留先注册者」，无行为回归。
        let id = cap.id();
        {
            let handles = self.handles.read().unwrap();
            if handles.values().any(|c| c.id() == id) {
                tracing::warn!(capability = %id.0, "register_handle: 能力 id 已注册，拒绝重复注册");
                return Err(format!("能力 {} 已注册，不可重复注册", id.0));
            }
        }
        let handle = self.next_handle.fetch_add(1, Ordering::SeqCst);
        let mut handles = self.handles.write().unwrap();
        handles.insert(handle, Arc::from(cap));
        Ok(handle)
    }
}"""
assert old in s; s = s.replace(old, new)

old = """    pub fn register_handle_arc(&self, cap: Arc<dyn Capability>) -> Result<CapabilityHandle, String> {
        let handle = self.next_handle.fetch_add(1, Ordering::SeqCst);
        let mut handles = self.handles.write().unwrap();
        handles.insert(handle, cap);
        Ok(handle)
    }"""
new = """    pub fn register_handle_arc(&self, cap: Arc<dyn Capability>) -> Result<CapabilityHandle, String> {
        // X12：同 register_handle——同 id 拒绝（幂等注册走 register_streaming 语义）
        let id = cap.id();
        {
            let handles = self.handles.read().unwrap();
            if handles.values().any(|c| c.id() == id) {
                tracing::warn!(capability = %id.0, "register_handle_arc: 能力 id 已注册，拒绝重复注册");
                return Err(format!("能力 {} 已注册，不可重复注册", id.0));
            }
        }
        let handle = self.next_handle.fetch_add(1, Ordering::SeqCst);
        let mut handles = self.handles.write().unwrap();
        handles.insert(handle, cap);
        Ok(handle)
    }"""
assert old in s; s = s.replace(old, new)

old = """pub struct RealContext {
    source: Source,
    storage: Option<Arc<dyn Storage>>,
    plugin_config: Value,
    broadcaster: Option<Arc<EventAdapter>>,
    caller_id: PluginId,
}

impl RealContext {
    pub fn new(
        source: Source,
        storage: Option<Arc<dyn Storage>>,
        plugin_config: Value,
        broadcaster: Option<Arc<EventAdapter>>,
    ) -> Self {
        Self {
            source,
            storage,
            plugin_config,
            broadcaster,
            caller_id: PluginId("core".into()),
        }
    }
}"""
new = """pub struct RealContext {
    source: Source,
    storage: Option<Arc<dyn Storage>>,
    plugin_config: Value,
    broadcaster: Option<Arc<EventAdapter>>,
    caller_id: PluginId,
    /// 与 dispatch 同源的权限策略（2026-10-24 审计：RealContext.check_permission
    /// 此前恒 Allow——能力内二次裁决拿不到策略）。dispatch 注入。
    permission: Option<Arc<dyn Permission>>,
}

impl RealContext {
    pub fn new(
        source: Source,
        storage: Option<Arc<dyn Storage>>,
        plugin_config: Value,
        broadcaster: Option<Arc<EventAdapter>>,
    ) -> Self {
        Self {
            source,
            storage,
            plugin_config,
            broadcaster,
            caller_id: derive_caller_id(&source),
            permission: None,
        }
    }

    /// dispatch 用构造：附加与主 gate 同源的权限策略（能力内二次裁决）
    pub fn with_permission(
        source: Source,
        storage: Option<Arc<dyn Storage>>,
        plugin_config: Value,
        broadcaster: Option<Arc<EventAdapter>>,
        permission: Arc<dyn Permission>,
    ) -> Self {
        Self {
            caller_id: derive_caller_id(&source),
            source,
            storage,
            plugin_config,
            broadcaster,
            permission: Some(permission),
        }
    }
}

/// 调用方插件 id：Plugin 来源取 caller；Bootstrap/Remote（非插件进程）为 core
fn derive_caller_id(source: &Source) -> PluginId {
    match source {
        Source::Plugin { caller } => caller.clone(),
        _ => PluginId("core".into()),
    }
}"""
assert old in s; s = s.replace(old, new)

old = """    fn check_permission(&self, _req: &PermissionRequest) -> Result<PermissionVerdict, String> {
        Ok(PermissionVerdict::Allow)
    }"""
new = """    fn check_permission(&self, req: &PermissionRequest) -> Result<PermissionVerdict, String> {
        match &self.permission {
            Some(p) => p.check(req),
            // 无策略上下文（测试/独立构造）：保持历史 Allow 语义
            None => Ok(PermissionVerdict::Allow),
        }
    }"""
assert old in s; s = s.replace(old, new)

# dispatch 3 处 RealContext::new → with_permission
s = s.replace("""let ctx = RealContext::new(
                    env.source.clone(),
                    self.storage.clone(),
                    plugin_config,
                    Some(self.broadcaster.clone()),
                );""", """let ctx = RealContext::with_permission(
                    env.source.clone(),
                    self.storage.clone(),
                    plugin_config,
                    Some(self.broadcaster.clone()),
                    self.permission.clone(),
                );""")
s = s.replace("""                    let ctx = RealContext::new(
                        env.source.clone(),
                        self.storage.clone(),
                        plugin_config,
                        Some(self.broadcaster.clone()),
                    );""", """                    let ctx = RealContext::with_permission(
                        env.source.clone(),
                        self.storage.clone(),
                        plugin_config,
                        Some(self.broadcaster.clone()),
                        self.permission.clone(),
                    );""")
s = s.replace("""        let ctx = RealContext::new(
            env.source.clone(),
            self.storage.clone(),
            plugin_config,
            Some(self.broadcaster.clone()),
        );""", """        let ctx = RealContext::with_permission(
            env.source.clone(),
            self.storage.clone(),
            plugin_config,
            Some(self.broadcaster.clone()),
            self.permission.clone(),
        );""")
assert 'RealContext::new(' not in s, 'mod.rs still has RealContext::new'

# 测试 make_router Box→Arc
s = s.replace("""    fn make_router(
        permission: Box<dyn Permission>,""", """    fn make_router(
        permission: Arc<dyn Permission>,""")
s = re.sub(r'Box::new\((AllowAllPermission|DenyRemotePermission|ProgrammablePermission\([^)]*\)|DenyRemoteForCap\([^)]*\))\)', r'Arc::new(\1)', s)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('router/mod.rs done')

# ============ state.rs / bus_mcp_server.rs ============
for p, olds in [
    ('src-tauri/src/state.rs', [("        let permission = Box::new(policy_permission);", "        let permission = Arc::new(policy_permission);")]),
    ('src-tauri/src/services/bus_mcp_server.rs', [("    let permission = Box::new(policy);", "    let permission = Arc::new(policy);")]),
]:
    s = io.open(p, encoding='utf-8').read()
    for old, new in olds:
        assert old in s, (p, old)
        s = s.replace(old, new)
    io.open(p, 'w', encoding='utf-8', newline='').write(s)
    print(p, 'migrated')
