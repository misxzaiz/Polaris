---
title: Bash tool
url: https://platform.claude.com/docs/en/agents-and-tools/tool-use/bash-tool
description: Let Claude request shell commands that your application runs in a persistent bash session and returns as tool results.
---

<Note>
  To learn how zero data retention (ZDR) applies to this feature, see [API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention).
</Note>

The bash tool is a [client tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works): Claude doesn't run commands itself. When you include the tool in a request, Claude replies with a `tool_use` block that names the command to run. Your application runs that command in a bash session it owns and returns the output in a `tool_result` block.

Your application keeps one bash process alive across tool calls, so state persists between commands. The working directory, environment variables, and any files a command creates are still there for the next command.

The current version of the tool is `bash_20250124`. For model support, beta headers, and the earlier version, see [Tool versions](https://platform.claude.com/docs/en/agents-and-tools/tool-use/bash-tool#tool-versions). For all Anthropic-provided tools, see the [Tool reference](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference).

## Use cases

* **Development workflows:** Run build commands, tests, and development tools
* **System automation:** Execute scripts, manage files, automate tasks
* **Data processing:** Process files, run analysis scripts, manage datasets
* **Environment setup:** Install packages, configure environments

## Quick start

<CodeGroup>
  ```bash cURL
  curl https://api.anthropic.com/v1/messages \
    -H "content-type: application/json" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -d '{
      "model": "claude-opus-5-5",
      "max_tokens": 1024,
      "tools": [
        {
          "type": "bash_20250124",
          "name": "bash"
        }
      ],
      "messages": [
        {
          "role": "user",
          "content": "List all Python files in the current directory."
        }
      ]
    }'
  ```

  ```bash CLI
  ant messages create \
    --model claude-opus-5-5 \
    --max-tokens 1024 \
    --tool '{type: bash_20250124, name: bash}' \
    --message '{role: user, content: List all Python files in the current directory.}'
  ```

  ```python Python
  client = anthropic.Anthropic()

  response = client.messages.create(
      model="claude-opus-5-5",
      max_tokens=1024,
      tools=[{"type": "bash_20250124", "name": "bash"}],
      messages=[
          {"role": "user", "content": "List all Python files in the current directory."}
      ],
  )

  print(response)
  ```

  ```typescript TypeScript
  const client = new Anthropic();

  const response = await client.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 1024,
    tools: [{ type: "bash_20250124", name: "bash" }],
    messages: [
      {
        role: "user",
        content: "List all Python files in the current directory."
      }
    ]
  });

  console.log(response);
  ```

  ```csharp C#
  var client = new AnthropicClient();

  var response = await client.Messages.Create(
      new()
      {
          Model = Model.ClaudeOpus5_5,
          MaxTokens = 1024,
          Tools = [new ToolBash20250124()],
          Messages =
          [
              new()
              {
                  Role = Role.User,
                  Content = "List all Python files in the current directory.",
              },
          ],
      }
  );

  Console.WriteLine(response);
  ```

  ```go Go
  client := anthropic.NewClient()

  response, err := client.Messages.New(context.TODO(), anthropic.MessageNewParams{
  	Model:     anthropic.ModelClaudeOpus5_5,
  	MaxTokens: 1024,
  	Tools: []anthropic.ToolUnionParam{
  		{OfBashTool20250124: &anthropic.ToolBash20250124Param{}},
  	},
  	Messages: []anthropic.MessageParam{
  		anthropic.NewUserMessage(anthropic.NewTextBlock("List all Python files in the current directory.")),
  	},
  })
  if err != nil {
  	log.Fatal(err)
  }
  fmt.Println(response)
  ```

  ```java Java
  import com.anthropic.models.messages.ToolBash20250124;

  void main() {
      AnthropicClient client = AnthropicOkHttpClient.fromEnv();

      Message response = client.messages().create(
          MessageCreateParams.builder()
              .model(Model.CLAUDE_OPUS_5_5)
              .maxTokens(1024)
              .addTool(ToolBash20250124.builder().build())
              .addUserMessage("List all Python files in the current directory.")
              .build()
      );

      IO.println(response);
  }
  ```

  ```php PHP
  use Anthropic\Messages\ToolBash20250124;

  $client = new Client();

  $response = $client->messages->create(
      model: 'claude-opus-5-5',
      maxTokens: 1024,
      tools: [new ToolBash20250124()],
      messages: [
          ['role' => 'user', 'content' => 'List all Python files in the current directory.'],
      ],
  );

  echo $response;
  ```

  ```ruby Ruby
  client = Anthropic::Client.new

  response = client.messages.create(
    model: "claude-opus-5-5",
    max_tokens: 1024,
    tools: [{type: "bash_20250124", name: "bash"}],
    messages: [
      {role: "user", content: "List all Python files in the current directory."}
    ]
  )

  puts response
  ```
</CodeGroup>

Claude responds with `stop_reason: "tool_use"` and a `tool_use` block that contains the command for your application to run:

```json Output
{
  "id": "msg_01XAbCDeFgHiJkLmNoPQrStU",
  "model": "claude-opus-5-5",
  "stop_reason": "tool_use",
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "I'll list all Python files in the current directory for you."
    },
    {
      "type": "tool_use",
      "id": "toolu_01A09q90qw90lq917835lq9",
      "name": "bash",
      "input": {
        "command": "ls *.py"
      }
    }
  ]
}
```

Run `input.command` in your bash session and send the output back as a `tool_result`. See [Implement the bash tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/bash-tool#implement-the-bash-tool) for the round trip.

## How it works

Each tool call is one round trip between Claude and your application:

1. Claude returns a `tool_use` block containing the `command` to run.
2. Your application runs the command in its bash session.
3. Your application returns the command's output, stdout and stderr together, to Claude in a `tool_result` block.
4. Claude either requests another command in the same session or responds with text.

Claude can also return several `tool_use` blocks in one response. Run them in order in the same session and return all of the results in one `user` message. See [Parallel tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use).

The API is stateless. Nothing about your shell session travels between requests, so your application decides when the session starts, how long it lives, and when to restart it. For the full request and response cycle, see [Handle tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls).

## Parameters

A bash tool definition has two required fields, `type` and `name`, and the `name` must be `bash`. The tool is schema-less: you don't provide an `input_schema`, because the schema is built into Claude's model and can't be modified. The following table lists the input fields Claude sets when it calls the tool.

| Parameter | Required | Description                               |
| --------- | -------- | ----------------------------------------- |
| `command` | Yes\*    | The bash command to run                   |
| `restart` | No       | Set to `true` to restart the bash session |

\*Required unless using `restart`

To handle `restart: true`, kill the shell process, start a new one, and return a `tool_result` that confirms the restart. A restarted session starts clean: the working directory, environment variables, and any running processes are gone.

<Accordion title="Example usage">
  Run a command:

  ```json
  {
    "command": "ls -la *.py"
  }
  ```

  Restart the session:

  ```json
  {
    "restart": true
  }
  ```
</Accordion>

## Tool versions

`bash_20250124` is the current version of the tool, and it requires no beta header. Every model from Claude Sonnet 3.7 ([retired](https://platform.claude.com/docs/en/about-claude/model-deprecations)) onward accepts it, including all current Claude models.

The original `bash_20241022` version works only with the October 2024 Claude Sonnet 3.5 model ([retired](https://platform.claude.com/docs/en/about-claude/model-deprecations)). Requests that use it need the `anthropic-beta: computer-use-2024-10-22` header, and the SDK exposes it only in its beta namespace. New integrations should use `bash_20250124`.

## Example: Multistep automation

Claude can chain commands across tool calls to complete a multistep task:

```text
User request:
"Install the requests library and create a simple Python script that
fetches a joke from an API, then run it."

Claude's tool uses:
1. Install package
   {"command": "pip install requests"}

2. Create script
   {"command": "cat > fetch_joke.py << 'EOF'\nimport requests\nresponse = requests.get('https://official-joke-api.appspot.com/random_joke')\njoke = response.json()\nprint(f\"Setup: {joke['setup']}\")\nprint(f\"Punchline: {joke['punchline']}\")\nEOF"}

3. Run script
   {"command": "python fetch_joke.py"}
```

The session maintains state between commands, so files created in step 2 are available in step 3.

## Implement the bash tool

Claude determines which command to run. Your application owns everything else: the shell process, the timeout, and the safety checks. The following steps show a minimal implementation.

<Steps>
  <Step title="Create a persistent bash session">
    Start one long-lived bash process and run every command inside it. Because a pipe to a live process never reports end-of-file, the session prints a unique sentinel line after each command to mark where that command's output ends:

    <CodeGroup exclude="shell">
      ```python Python
      import subprocess
      import uuid


      class BashSession:
          """A bash process that stays alive between commands so state persists."""

          def __init__(self):
              self.process = subprocess.Popen(
                  ["/bin/bash"],
                  stdin=subprocess.PIPE,
                  stdout=subprocess.PIPE,
                  stderr=subprocess.STDOUT,  # interleave errors with output, in order
                  start_new_session=True,  # own process group: a timeout can kill every child
                  text=True,
              )

          def execute_command(self, command):
              """Run a command in the session and return its output."""
              sentinel = f"__CLAUDE_BASH_DONE_{uuid.uuid4().hex}__"  # unique per call
              self.process.stdin.write(f"{command}\necho {sentinel}\n")
              self.process.stdin.flush()

              output = []
              for line in self.process.stdout:
                  if sentinel in line:  # this command's output is complete
                      break
                  output.append(line)
              return "".join(output)

          def restart(self):
              self.process.kill()
              self.process.wait()
              self.__init__()


      bash_session = BashSession()
      print(bash_session.execute_command("cd /tmp && pwd"))
      print(bash_session.execute_command("pwd"))  # still /tmp: the session kept its state
      ```

      ```typescript TypeScript
      import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
      import { createInterface, type Interface } from "node:readline";
      import { randomUUID } from "node:crypto";

      // A bash process that stays alive between commands so state persists.
      class BashSession {
        process!: ChildProcessWithoutNullStreams;
        private lines!: Interface;

        constructor() {
          this.start();
        }

        private start(): void {
          this.process = spawn("/bin/bash", {
            detached: true // own process group: a timeout can kill every child
          });
          this.process.stdin.write("exec 2>&1\n"); // interleave errors with output, in order
          this.lines = createInterface({ input: this.process.stdout });
        }

        // Run a command in the session and return its output.
        executeCommand(command: string): Promise<string> {
          const sentinel = `__CLAUDE_BASH_DONE_${randomUUID()}__`; // unique per call
          const output: string[] = [];
          const result = new Promise<string>((resolve) => {
            const onLine = (line: string): void => {
              if (line.includes(sentinel)) {
                // this command's output is complete
                this.lines.off("line", onLine);
                resolve(output.join(""));
              } else {
                output.push(`${line}\n`);
              }
            };
            this.lines.on("line", onLine);
          });
          this.process.stdin.write(`${command}\necho ${sentinel}\n`);
          return result;
        }

        restart(): void {
          this.process.kill("SIGKILL");
          this.lines.close();
          this.start();
        }
      }

      const session = new BashSession();
      console.log(await session.executeCommand("cd /tmp && pwd"));
      console.log(await session.executeCommand("pwd")); // still /tmp: the session kept its state
      session.process.stdin.end(); // closing stdin ends the shell so the script can exit
      ```

      ```csharp C#
      using System.Diagnostics;
      using System.Text;

      var session = new BashSession();
      Console.Write(session.ExecuteCommand("cd /tmp && pwd"));
      Console.Write(session.ExecuteCommand("pwd")); // still /tmp: the session kept its state

      // A bash process that stays alive between commands so state persists.
      class BashSession
      {
          public Process Process { get; private set; }

          public BashSession()
          {
              Process = Start();
          }

          static Process Start()
          {
              var process = Process.Start(new ProcessStartInfo("/bin/bash")
              {
                  RedirectStandardInput = true,
                  RedirectStandardOutput = true
              })!;
              process.StandardInput.Write("exec 2>&1\n"); // interleave errors with output, in order
              process.StandardInput.Flush();
              return process;
          }

          // Run a command in the session and return its output.
          public string ExecuteCommand(string command)
          {
              var sentinel = $"__CLAUDE_BASH_DONE_{Guid.NewGuid():N}__"; // unique per call
              Process.StandardInput.Write($"{command}\necho {sentinel}\n");
              Process.StandardInput.Flush();

              var output = new StringBuilder();
              while (Process.StandardOutput.ReadLine() is string line)
              {
                  if (line.Contains(sentinel)) // this command's output is complete
                  {
                      break;
                  }
                  output.Append(line).Append('\n');
              }
              return output.ToString();
          }

          public void Restart()
          {
              Process.Kill(entireProcessTree: true);
              Process.WaitForExit();
              Process = Start();
          }
      }
      ```

      ```go Go
      import (
      	"bufio"
      	"crypto/rand"
      	"encoding/hex"
      	"fmt"
      	"io"
      	"log"
      	"os/exec"
      	"strings"
      	"syscall"
      )

      // BashSession is a bash process that stays alive between commands so state persists.
      type BashSession struct {
      	cmd    *exec.Cmd
      	stdin  io.WriteCloser
      	output *bufio.Reader
      }

      func NewBashSession() (*BashSession, error) {
      	cmd := exec.Command("/bin/bash")
      	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} // own process group: a timeout can kill every child
      	stdin, err := cmd.StdinPipe()
      	if err != nil {
      		return nil, err
      	}
      	stdout, err := cmd.StdoutPipe()
      	if err != nil {
      		return nil, err
      	}
      	cmd.Stderr = cmd.Stdout // interleave errors with output, in order
      	if err := cmd.Start(); err != nil {
      		return nil, err
      	}
      	return &BashSession{cmd: cmd, stdin: stdin, output: bufio.NewReader(stdout)}, nil
      }

      // ExecuteCommand runs a command in the session and returns its output.
      func (s *BashSession) ExecuteCommand(command string) string {
      	buf := make([]byte, 16)
      	rand.Read(buf)
      	sentinel := fmt.Sprintf("__CLAUDE_BASH_DONE_%s__", hex.EncodeToString(buf)) // unique per call
      	fmt.Fprintf(s.stdin, "%s\necho %s\n", command, sentinel)

      	var output strings.Builder
      	for {
      		line, err := s.output.ReadString('\n')
      		if err != nil || strings.Contains(line, sentinel) { // this command's output is complete
      			break
      		}
      		output.WriteString(line)
      	}
      	return output.String()
      }

      // Restart kills the shell and starts a fresh session in its place.
      func (s *BashSession) Restart() error {
      	s.cmd.Process.Kill()
      	s.cmd.Wait()
      	fresh, err := NewBashSession()
      	if err != nil {
      		return err
      	}
      	*s = *fresh
      	return nil
      }

      func main() {
      	session, err := NewBashSession()
      	if err != nil {
      		log.Fatal(err)
      	}
      	fmt.Print(session.ExecuteCommand("cd /tmp && pwd"))
      	fmt.Print(session.ExecuteCommand("pwd")) // still /tmp: the session kept its state
      }
      ```

      ```java Java
      import java.io.BufferedReader;
      import java.io.BufferedWriter;
      import java.io.IOException;
      import java.io.InputStreamReader;
      import java.io.OutputStreamWriter;
      import java.util.UUID;

      // A bash process that stays alive between commands so state persists.
      class BashSession {
          Process process;
          BufferedWriter stdin;
          BufferedReader output;

          BashSession() throws IOException {
              start();
          }

          void start() throws IOException {
              ProcessBuilder builder = new ProcessBuilder("/bin/bash");
              builder.redirectErrorStream(true); // interleave errors with output, in order
              process = builder.start();
              stdin = new BufferedWriter(new OutputStreamWriter(process.getOutputStream()));
              output = new BufferedReader(new InputStreamReader(process.getInputStream()));
          }

          // Run a command in the session and return its output.
          String executeCommand(String command) throws IOException {
              String sentinel = "__CLAUDE_BASH_DONE_" + UUID.randomUUID() + "__"; // unique per call
              stdin.write(command + "\necho " + sentinel + "\n");
              stdin.flush();

              StringBuilder result = new StringBuilder();
              String line;
              while ((line = output.readLine()) != null) {
                  if (line.contains(sentinel)) { // this command's output is complete
                      break;
                  }
                  result.append(line).append("\n");
              }
              return result.toString();
          }

          void restart() throws IOException, InterruptedException {
              process.destroyForcibly();
              process.waitFor();
              start();
          }
      }

      void main() throws Exception {
          BashSession session = new BashSession();
          IO.println(session.executeCommand("cd /tmp && pwd"));
          IO.println(session.executeCommand("pwd")); // still /tmp: the session kept its state
      }
      ```

      ```php PHP
      // A bash process that stays alive between commands so state persists.
      class BashSession
      {
          public $process;
          public $stdin;
          public $output;

          public function __construct()
          {
              $this->start();
          }

          private function start(): void
          {
              // setsid gives the shell its own process group: a timeout can kill every child
              $this->process = proc_open(
                  ['setsid', '/bin/bash'],
                  [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['redirect', 1]], // interleave errors with output
                  $pipes
              );
              $this->stdin = $pipes[0];
              $this->output = $pipes[1];
          }

          // Run a command in the session and return its output.
          public function executeCommand(string $command): string
          {
              $sentinel = '__CLAUDE_BASH_DONE_' . bin2hex(random_bytes(16)) . '__'; // unique per call
              fwrite($this->stdin, "{$command}\necho {$sentinel}\n");
              fflush($this->stdin);

              $output = '';
              while (($line = fgets($this->output)) !== false) {
                  if (str_contains($line, $sentinel)) { // this command's output is complete
                      break;
                  }
                  $output .= $line;
              }
              return $output;
          }

          public function restart(): void
          {
              proc_terminate($this->process, 9);
              proc_close($this->process);
              $this->start();
          }
      }

      $session = new BashSession();
      echo $session->executeCommand("cd /tmp && pwd");
      echo $session->executeCommand("pwd"); // still /tmp: the session kept its state
      ```

      ```ruby Ruby
      require "open3"
      require "securerandom"

      # A bash process that stays alive between commands so state persists.
      class BashSession
        attr_reader :output, :wait_thread

        def initialize
          start
        end

        # Run a command in the session and return its output.
        def execute_command(command)
          sentinel = "__CLAUDE_BASH_DONE_#{SecureRandom.hex(16)}__" # unique per call
          @stdin.write("#{command}\necho #{sentinel}\n")
          @stdin.flush

          output = +""
          @output.each_line do |line|
            break if line.include?(sentinel) # this command's output is complete

            output << line
          end
          output
        end

        def restart
          Process.kill("KILL", @wait_thread.pid)
          @wait_thread.join
          start
        end

        private

        def start
          # popen2e interleaves errors with output, in order; pgroup gives the shell its
          # own process group so a timeout can kill every child
          @stdin, @output, @wait_thread = Open3.popen2e("/bin/bash", pgroup: true)
        end
      end

      session = BashSession.new
      puts session.execute_command("cd /tmp && pwd")
      puts session.execute_command("pwd") # still /tmp: the session kept its state
      ```
    </CodeGroup>

    The session interleaves stderr with stdout, so error messages land where they happened. The example leaves out what a complete implementation also needs: a timeout that kills the shell and every process it started when a command hangs, then restarts the session. The [Use command timeouts](https://platform.claude.com/docs/en/agents-and-tools/tool-use/bash-tool#follow-implementation-best-practices) best practice shows one way to add it.
  </Step>

  <Step title="Process Claude's tool calls">
    Extract and run commands from Claude's responses:

    <CodeGroup exclude="shell">
      ```python Python
      tool_results = []
      for content in response.content:
          if content.type == "tool_use" and content.name == "bash":
              if content.input.get("restart"):
                  bash_session.restart()
                  result = "Bash session restarted"
              else:
                  command = content.input.get("command")
                  result = bash_session.execute_command(command)

              # One tool_result per tool_use block, all returned in the next user message
              tool_results.append(
                  {"type": "tool_result", "tool_use_id": content.id, "content": result}
              )
      ```

      ```typescript TypeScript
      const toolResults: { type: string; tool_use_id: string; content: string }[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use" && block.name === "bash") {
          let result: string;
          if (block.input.restart) {
            bashSession.restart();
            result = "Bash session restarted";
          } else {
            result = await bashSession.executeCommand(block.input.command ?? "");
          }

          // One tool_result per tool_use block, all returned in the next user message
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
        }
      }
      ```

      ```csharp C#
      var toolResults = new List<ToolResultBlockParam>();
      foreach (var block in response.Content)
      {
          if (block.TryPickToolUse(out var toolUse) && toolUse.Name == "bash")
          {
              string result;
              if (toolUse.Input.TryGetValue("restart", out var restart) && restart.GetBoolean())
              {
                  bashSession.Restart();
                  result = "Bash session restarted";
              }
              else
              {
                  var command = toolUse.Input["command"].GetString() ?? "";
                  result = bashSession.ExecuteCommand(command);
              }

              // One tool_result per tool_use block, all returned in the next user message
              toolResults.Add(new ToolResultBlockParam { ToolUseID = toolUse.ID, Content = result });
          }
      }
      ```

      ```go Go
      var toolResults []anthropic.ContentBlockParamUnion
      for _, block := range response.Content {
      	if block.Type == "tool_use" && block.Name == "bash" {
      		var input struct {
      			Command string `json:"command"`
      			Restart bool   `json:"restart"`
      		}
      		if err := json.Unmarshal(block.Input, &input); err != nil {
      			log.Fatal(err)
      		}

      		var result string
      		if input.Restart {
      			bashSession.Restart()
      			result = "Bash session restarted"
      		} else {
      			result = bashSession.ExecuteCommand(input.Command)
      		}

      		// One tool_result per tool_use block, all returned in the next user message
      		toolResults = append(toolResults, anthropic.NewToolResultBlock(block.ID, result, false))
      	}
      }
      ```

      ```java Java
      List<Map<String, Object>> toolResults = new ArrayList<>();
      for (ContentBlock block : response.content()) {
          if (block.type().equals("tool_use") && block.name().equals("bash")) {
              String result;
              if (Boolean.TRUE.equals(block.input().get("restart"))) {
                  bashSession.restart();
                  result = "Bash session restarted";
              } else {
                  String command = (String) block.input().get("command");
                  result = bashSession.executeCommand(command);
              }

              // One tool_result per tool_use block, all returned in the next user message
              toolResults.add(Map.of("type", "tool_result", "tool_use_id", block.id(), "content", result));
          }
      }
      ```

      ```php PHP
      $toolResults = [];
      foreach ($response->content as $block) {
          if ($block->type === 'tool_use' && $block->name === 'bash') {
              if (!empty($block->input['restart'])) {
                  $bashSession->restart();
                  $result = 'Bash session restarted';
              } else {
                  $result = $bashSession->executeCommand($block->input['command']);
              }

              // One tool_result per tool_use block, all returned in the next user message
              $toolResults[] = ['type' => 'tool_result', 'tool_use_id' => $block->id, 'content' => $result];
          }
      }
      ```

      ```ruby Ruby
      tool_results = []
      response.content.each do |block|
        next unless block.type == :tool_use && block.name == "bash"

        result =
          if block.input[:restart]
            bash_session.restart
            "Bash session restarted"
          else
            bash_session.execute_command(block.input[:command])
          end

        # One tool_result per tool_use block, all returned in the next user message
        tool_results << {type: "tool_result", tool_use_id: block.id, content: result}
      end
      ```
    </CodeGroup>
  </Step>

  <Step title="Return the result to Claude">
    Send the `tool_result` back in a `user` message that continues the same conversation. Claude either requests another command in the same session or finishes its answer:

    <CodeGroup>
      ```bash cURL
      curl https://api.anthropic.com/v1/messages \
        -H "content-type: application/json" \
        -H "x-api-key: $ANTHROPIC_API_KEY" \
        -H "anthropic-version: 2023-06-01" \
        -d '{
          "model": "claude-opus-5-5",
          "max_tokens": 1024,
          "tools": [
            {
              "type": "bash_20250124",
              "name": "bash"
            }
          ],
          "messages": [
            {
              "role": "user",
              "content": "List all Python files in the current directory."
            },
            {
              "role": "assistant",
              "content": [
                {
                  "type": "tool_use",
                  "id": "toolu_01A09q90qw90lq917835lq9",
                  "name": "bash",
                  "input": {
                    "command": "ls *.py"
                  }
                }
              ]
            },
            {
              "role": "user",
              "content": [
                {
                  "type": "tool_result",
                  "tool_use_id": "toolu_01A09q90qw90lq917835lq9",
                  "content": "analysis.py\nprocess_data.py\n"
                }
              ]
            }
          ]
        }'
      ```

      ```bash CLI
      ant messages create <<'YAML'
      model: claude-opus-5-5
      max_tokens: 1024
      tools:
        - type: bash_20250124
          name: bash
      messages:
        - role: user
          content: List all Python files in the current directory.
        - role: assistant
          content:
            - type: tool_use
              id: toolu_01A09q90qw90lq917835lq9
              name: bash
              input:
                command: ls *.py
        - role: user
          content:
            - type: tool_result
              tool_use_id: toolu_01A09q90qw90lq917835lq9
              content: |
                analysis.py
                process_data.py
      YAML
      ```

      ```python Python
      client = anthropic.Anthropic()

      response = client.messages.create(
          model="claude-opus-5-5",
          max_tokens=1024,
          tools=[{"type": "bash_20250124", "name": "bash"}],
          messages=[
              {"role": "user", "content": "List all Python files in the current directory."},
              {
                  "role": "assistant",
                  "content": [
                      {
                          "type": "tool_use",
                          "id": "toolu_01A09q90qw90lq917835lq9",
                          "name": "bash",
                          "input": {"command": "ls *.py"},
                      }
                  ],
              },
              {
                  "role": "user",
                  "content": [
                      {
                          "type": "tool_result",
                          "tool_use_id": "toolu_01A09q90qw90lq917835lq9",
                          "content": "analysis.py\nprocess_data.py\n",
                      }
                  ],
              },
          ],
      )

      print(response.content)
      ```

      ```typescript TypeScript
      const client = new Anthropic();

      const response = await client.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 1024,
        tools: [{ type: "bash_20250124", name: "bash" }],
        messages: [
          {
            role: "user",
            content: "List all Python files in the current directory."
          },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_01A09q90qw90lq917835lq9",
                name: "bash",
                input: { command: "ls *.py" }
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_01A09q90qw90lq917835lq9",
                content: "analysis.py\nprocess_data.py\n"
              }
            ]
          }
        ]
      });

      console.log(response.content);
      ```

      ```csharp C#
      var client = new AnthropicClient();

      var response = await client.Messages.Create(
          new()
          {
              Model = Model.ClaudeOpus5_5,
              MaxTokens = 1024,
              Tools = [new ToolBash20250124()],
              Messages =
              [
                  new()
                  {
                      Role = Role.User,
                      Content = "List all Python files in the current directory.",
                  },
                  new()
                  {
                      Role = Role.Assistant,
                      Content = new MessageParamContent(new List<ContentBlockParam>
                      {
                          new ContentBlockParam(new ToolUseBlockParam()
                          {
                              ID = "toolu_01A09q90qw90lq917835lq9",
                              Name = "bash",
                              Input = new Dictionary<string, JsonElement>
                              {
                                  ["command"] = JsonSerializer.SerializeToElement("ls *.py"),
                              },
                          }),
                      }),
                  },
                  new()
                  {
                      Role = Role.User,
                      Content = new MessageParamContent(new List<ContentBlockParam>
                      {
                          new ContentBlockParam(new ToolResultBlockParam()
                          {
                              ToolUseID = "toolu_01A09q90qw90lq917835lq9",
                              Content = "analysis.py\nprocess_data.py\n",
                          }),
                      }),
                  },
              ],
          }
      );

      Console.WriteLine(response);
      ```

      ```go Go
      client := anthropic.NewClient()

      response, err := client.Messages.New(context.TODO(), anthropic.MessageNewParams{
      	Model:     anthropic.ModelClaudeOpus5_5,
      	MaxTokens: 1024,
      	Tools: []anthropic.ToolUnionParam{
      		{OfBashTool20250124: &anthropic.ToolBash20250124Param{}},
      	},
      	Messages: []anthropic.MessageParam{
      		anthropic.NewUserMessage(anthropic.NewTextBlock("List all Python files in the current directory.")),
      		anthropic.NewAssistantMessage(
      			anthropic.NewToolUseBlock(
      				"toolu_01A09q90qw90lq917835lq9",
      				map[string]any{"command": "ls *.py"},
      				"bash",
      			),
      		),
      		anthropic.NewUserMessage(
      			anthropic.NewToolResultBlock(
      				"toolu_01A09q90qw90lq917835lq9",
      				"analysis.py\nprocess_data.py\n",
      				false,
      			),
      		),
      	},
      })
      if err != nil {
      	log.Fatal(err)
      }
      fmt.Println(response.Content)
      ```

      ```java Java
      import com.anthropic.core.JsonValue;
      import com.anthropic.models.messages.ContentBlockParam;
      // ...
      import com.anthropic.models.messages.ToolBash20250124;
      import com.anthropic.models.messages.ToolResultBlockParam;
      import com.anthropic.models.messages.ToolUseBlockParam;
      // ...
      void main() {
          AnthropicClient client = AnthropicOkHttpClient.fromEnv();

          MessageCreateParams params = MessageCreateParams.builder()
              .model(Model.CLAUDE_OPUS_5_5)
              .maxTokens(1024)
              .addTool(ToolBash20250124.builder().build())
              .addUserMessage("List all Python files in the current directory.")
              .addAssistantMessageOfBlockParams(
                  List.of(
                      ContentBlockParam.ofToolUse(
                          ToolUseBlockParam.builder()
                              .id("toolu_01A09q90qw90lq917835lq9")
                              .name("bash")
                              .input(
                                  ToolUseBlockParam.Input.builder()
                                      .putAdditionalProperty("command", JsonValue.from("ls *.py"))
                                      .build()
                              )
                              .build()
                      )
                  )
              )
              .addUserMessageOfBlockParams(
                  List.of(
                      ContentBlockParam.ofToolResult(
                          ToolResultBlockParam.builder()
                              .toolUseId("toolu_01A09q90qw90lq917835lq9")
                              .content("analysis.py\nprocess_data.py\n")
                              .build()
                      )
                  )
              )
              .build();

          Message response = client.messages().create(params);
          IO.println(response.content());
      }
      ```

      ```php PHP
      use Anthropic\Messages\ToolBash20250124;

      $client = new Client();

      $response = $client->messages->create(
          model: 'claude-opus-5-5',
          maxTokens: 1024,
          tools: [new ToolBash20250124()],
          messages: [
              ['role' => 'user', 'content' => 'List all Python files in the current directory.'],
              [
                  'role' => 'assistant',
                  'content' => [
                      [
                          'type' => 'tool_use',
                          'id' => 'toolu_01A09q90qw90lq917835lq9',
                          'name' => 'bash',
                          'input' => ['command' => 'ls *.py'],
                      ],
                  ],
              ],
              [
                  'role' => 'user',
                  'content' => [
                      [
                          'type' => 'tool_result',
                          'tool_use_id' => 'toolu_01A09q90qw90lq917835lq9',
                          'content' => "analysis.py\nprocess_data.py\n",
                      ],
                  ],
              ],
          ],
      );

      print_r($response->content);
      ```

      ```ruby Ruby
      client = Anthropic::Client.new

      response = client.messages.create(
        model: "claude-opus-5-5",
        max_tokens: 1024,
        tools: [{type: "bash_20250124", name: "bash"}],
        messages: [
          {role: "user", content: "List all Python files in the current directory."},
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_01A09q90qw90lq917835lq9",
                name: "bash",
                input: {command: "ls *.py"}
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_01A09q90qw90lq917835lq9",
                content: "analysis.py\nprocess_data.py\n"
              }
            ]
          }
        ]
      )

      puts response.content
      ```
    </CodeGroup>

    Repeat the run-and-return cycle while `stop_reason` is `tool_use`. For the full loop, see [Handling results from client tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls#handling-results-from-client-tools).
  </Step>

  <Step title="Implement safety measures">
    Add validation and restrictions. Use an allowlist rather than a blocklist: a blocklist misses any command it didn't anticipate. The example also rejects shell operators that appear as separate words:

    <CodeGroup exclude="shell">
      ```python Python
      import shlex

      ALLOWED_COMMANDS = {"ls", "cat", "echo", "pwd", "grep", "find", "wc", "head", "tail"}
      SHELL_OPERATORS = {"&&", "||", "|", ";", "&", ">", "<", ">>"}


      def validate_command(command):
          # Allow only commands from an explicit allowlist
          try:
              tokens = shlex.split(command)
          except ValueError:
              return False, "Could not parse command"

          if not tokens:
              return False, "Empty command"

          executable = tokens[0]
          if executable not in ALLOWED_COMMANDS:
              return False, f"Command '{executable}' is not in the allowlist"

          # Reject shell operators written as separate words
          for token in tokens[1:]:
              if token in SHELL_OPERATORS or token.startswith(("$", "`")):
                  return False, f"Shell operator '{token}' is not allowed"

          return True, None
      ```

      ```typescript TypeScript
      const ALLOWED_COMMANDS = new Set([
        "ls",
        "cat",
        "echo",
        "pwd",
        "grep",
        "find",
        "wc",
        "head",
        "tail"
      ]);
      const SHELL_OPERATORS = new Set(["&&", "||", "|", ";", "&", ">", "<", ">>"]);

      function validateCommand(command: string): { ok: boolean; reason?: string } {
        // Split on whitespace: enough for a tripwire check
        const tokens = command.split(/\s+/).filter((token) => token.length > 0);
        if (tokens.length === 0) {
          return { ok: false, reason: "Empty command" };
        }

        // Allow only commands from an explicit allowlist
        const executable = tokens[0];
        if (!ALLOWED_COMMANDS.has(executable)) {
          return { ok: false, reason: `Command '${executable}' is not in the allowlist` };
        }

        // Reject shell operators written as separate words
        for (const token of tokens.slice(1)) {
          const bare = token.replace(/^["']+/, ""); // a quoted token can still smuggle an expansion
          if (SHELL_OPERATORS.has(token) || bare.startsWith("$") || bare.startsWith("`")) {
            return { ok: false, reason: `Shell operator '${token}' is not allowed` };
          }
        }

        return { ok: true };
      }
      ```

      ```csharp C#
      var allowedCommands = new HashSet<string>
      {
          "ls", "cat", "echo", "pwd", "grep", "find", "wc", "head", "tail"
      };
      var shellOperators = new HashSet<string> { "&&", "||", "|", ";", "&", ">", "<", ">>" };

      (bool Ok, string? Reason) ValidateCommand(string command)
      {
          // Split on whitespace: enough for a tripwire check
          var tokens = command.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
          if (tokens.Length == 0)
          {
              return (false, "Empty command");
          }

          // Allow only commands from an explicit allowlist
          var executable = tokens[0];
          if (!allowedCommands.Contains(executable))
          {
              return (false, $"Command '{executable}' is not in the allowlist");
          }

          // Reject shell operators written as separate words
          foreach (var token in tokens.Skip(1))
          {
              var bare = token.TrimStart('"', '\''); // a quoted token can still smuggle an expansion
              if (shellOperators.Contains(token) || bare.StartsWith('$') || bare.StartsWith('`'))
              {
                  return (false, $"Shell operator '{token}' is not allowed");
              }
          }

          return (true, null);
      }
      ```

      ```go Go
      var allowedCommands = map[string]bool{
      	"ls": true, "cat": true, "echo": true, "pwd": true, "grep": true,
      	"find": true, "wc": true, "head": true, "tail": true,
      }

      var shellOperators = map[string]bool{
      	"&&": true, "||": true, "|": true, ";": true, "&": true,
      	">": true, "<": true, ">>": true,
      }

      func validateCommand(command string) (bool, string) {
      	// Split on whitespace: enough for a tripwire check
      	tokens := strings.Fields(command)
      	if len(tokens) == 0 {
      		return false, "Empty command"
      	}

      	// Allow only commands from an explicit allowlist
      	executable := tokens[0]
      	if !allowedCommands[executable] {
      		return false, fmt.Sprintf("Command %q is not in the allowlist", executable)
      	}

      	// Reject shell operators written as separate words
      	for _, token := range tokens[1:] {
      		bare := strings.TrimLeft(token, `"'`) // a quoted token can still smuggle an expansion
      		if shellOperators[token] || strings.HasPrefix(bare, "$") || strings.HasPrefix(bare, "`") {
      			return false, fmt.Sprintf("Shell operator %q is not allowed", token)
      		}
      	}

      	return true, ""
      }
      ```

      ```java Java
      import java.util.List;
      import java.util.Set;

      static final Set<String> ALLOWED_COMMANDS =
          Set.of("ls", "cat", "echo", "pwd", "grep", "find", "wc", "head", "tail");
      static final Set<String> SHELL_OPERATORS = Set.of("&&", "||", "|", ";", "&", ">", "<", ">>");

      record Validation(boolean ok, String reason) {}

      Validation validateCommand(String command) {
          // Split on whitespace: enough for a tripwire check
          List<String> tokens = List.of(command.trim().split("\\s+"));
          if (tokens.size() == 1 && tokens.get(0).isEmpty()) {
              return new Validation(false, "Empty command");
          }

          // Allow only commands from an explicit allowlist
          String executable = tokens.get(0);
          if (!ALLOWED_COMMANDS.contains(executable)) {
              return new Validation(false, "Command '" + executable + "' is not in the allowlist");
          }

          // Reject shell operators written as separate words
          for (String token : tokens.subList(1, tokens.size())) {
              String bare = token.replaceFirst("^[\"']+", ""); // a quoted token can still smuggle an expansion
              if (SHELL_OPERATORS.contains(token) || bare.startsWith("$") || bare.startsWith("`")) {
                  return new Validation(false, "Shell operator '" + token + "' is not allowed");
              }
          }

          return new Validation(true, null);
      }
      ```

      ```php PHP
      const ALLOWED_COMMANDS = ['ls', 'cat', 'echo', 'pwd', 'grep', 'find', 'wc', 'head', 'tail'];
      const SHELL_OPERATORS = ['&&', '||', '|', ';', '&', '>', '<', '>>'];

      function validateCommand(string $command): array
      {
          // Split on whitespace: enough for a tripwire check
          $tokens = preg_split('/\\s+/', trim($command), -1, PREG_SPLIT_NO_EMPTY);
          if ($tokens === false || $tokens === []) {
              return [false, 'Empty command'];
          }

          // Allow only commands from an explicit allowlist
          $executable = $tokens[0];
          if (!in_array($executable, ALLOWED_COMMANDS, true)) {
              return [false, "Command '{$executable}' is not in the allowlist"];
          }

          // Reject shell operators written as separate words
          foreach (array_slice($tokens, 1) as $token) {
              $bare = ltrim($token, '"\''); // a quoted token can still smuggle an expansion
              if (in_array($token, SHELL_OPERATORS, true) || str_starts_with($bare, '$') || str_starts_with($bare, '`')) {
                  return [false, "Shell operator '{$token}' is not allowed"];
              }
          }

          return [true, null];
      }
      ```

      ```ruby Ruby
      require "shellwords"

      ALLOWED_COMMANDS = %w[ls cat echo pwd grep find wc head tail].freeze
      SHELL_OPERATORS = ["&&", "||", "|", ";", "&", ">", "<", ">>"].freeze

      def validate_command(command)
        # Allow only commands from an explicit allowlist
        begin
          tokens = Shellwords.split(command)
        rescue ArgumentError
          return [false, "Could not parse command"]
        end

        return [false, "Empty command"] if tokens.empty?

        executable = tokens[0]
        unless ALLOWED_COMMANDS.include?(executable)
          return [false, "Command '#{executable}' is not in the allowlist"]
        end

        # Reject shell operators written as separate words
        tokens[1..].each do |token|
          if SHELL_OPERATORS.include?(token) || token.start_with?("$", "`")
            return [false, "Shell operator '#{token}' is not allowed"]
          end
        end

        [true, nil]
      end
      ```
    </CodeGroup>

    This check is a tripwire for obvious mistakes, not an enforcement boundary. It rejects the spaced chaining (`&&`), pipes, and redirection that the other examples on this page use. It does not catch an operator glued to a word, such as `cat data.txt|grep x`, because the tokenizer keeps `data.txt|grep` inside one token. Decide which commands and operators your application allows. The real control is isolation: run the whole session inside a container or a virtual machine (see [Security](https://platform.claude.com/docs/en/agents-and-tools/tool-use/bash-tool#security)).
  </Step>
</Steps>

### Handle errors

When a command fails or the session breaks, tell Claude what happened. Return the message as the `tool_result` content and set `is_error` to `true`, which marks the tool call as failed. See [Handling errors with is\_error](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls#handling-errors-with-is-error).

<AccordionGroup>
  <Accordion title="Command execution timeout">
    If a command takes too long to execute:

    ```json
    {
      "role": "user",
      "content": [
        {
          "type": "tool_result",
          "tool_use_id": "toolu_01A09q90qw90lq917835lq9",
          "content": "Error: command did not finish within 30 seconds",
          "is_error": true
        }
      ]
    }
    ```
  </Accordion>

  <Accordion title="Command not found">
    If a command doesn't exist:

    ```json
    {
      "role": "user",
      "content": [
        {
          "type": "tool_result",
          "tool_use_id": "toolu_01A09q90qw90lq917835lq9",
          "content": "bash: nonexistentcommand: command not found",
          "is_error": true
        }
      ]
    }
    ```
  </Accordion>

  <Accordion title="Permission denied">
    If there are permission issues:

    ```json
    {
      "role": "user",
      "content": [
        {
          "type": "tool_result",
          "tool_use_id": "toolu_01A09q90qw90lq917835lq9",
          "content": "bash: /root/sensitive-file: Permission denied",
          "is_error": true
        }
      ]
    }
    ```
  </Accordion>
</AccordionGroup>

### Follow implementation best practices

<AccordionGroup>
  <Accordion title="Use command timeouts">
    A command that never finishes, such as one that waits for input, blocks the session forever because its sentinel line never arrives. Give every command a deadline. When the deadline passes, stop the shell and everything the command started, then restart the session:

    <CodeGroup exclude="shell">
      ```python Python
      import concurrent.futures
      import os
      import signal


      def execute_with_timeout(session, command, timeout=30):
          """Run a command in the session, replacing the session if the command hangs."""
          with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
              future = pool.submit(session.execute_command, command)
              try:
                  return future.result(timeout=timeout)
              except concurrent.futures.TimeoutError:
                  # The group is the shell and every process the command started
                  os.killpg(session.process.pid, signal.SIGKILL)
                  session.restart()
                  return f"Error: command did not finish within {timeout} seconds"
      ```

      ```typescript TypeScript
      // Run a command in the session, replacing the session if the command hangs.
      async function executeWithTimeout(
        session: BashSession,
        command: string,
        timeoutMs = 30000
      ): Promise<string> {
        let timer: NodeJS.Timeout | undefined;
        const timedOut = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
        });
        try {
          return await Promise.race([session.executeCommand(command), timedOut]);
        } catch {
          // The group is the shell and every process the command started
          if (session.process.pid !== undefined) {
            process.kill(-session.process.pid, "SIGKILL");
          }
          session.restart();
          return `Error: command did not finish within ${timeoutMs / 1000} seconds`;
        } finally {
          clearTimeout(timer);
        }
      }
      ```

      ```csharp C#
      using System.Diagnostics;

      // Run a command in the session, replacing the session if the command hangs.
      static string ExecuteWithTimeout(BashSession session, string command, int timeoutSeconds = 30)
      {
          var work = Task.Run(() => session.ExecuteCommand(command));
          if (work.Wait(TimeSpan.FromSeconds(timeoutSeconds)))
          {
              return work.Result;
          }

          // Stop the shell and every process it started, then start a fresh session
          session.Process.Kill(entireProcessTree: true);
          session.Restart();
          return $"Error: command did not finish within {timeoutSeconds} seconds";
      }
      ```

      ```go Go
      // executeWithTimeout runs a command, replacing the session if the command hangs.
      func executeWithTimeout(session *BashSession, command string, timeoutSeconds int) string {
      	done := make(chan string, 1)
      	go func() { done <- session.ExecuteCommand(command) }()

      	select {
      	case result := <-done:
      		return result
      	case <-time.After(time.Duration(timeoutSeconds) * time.Second):
      		// The group is the shell and every process the command started
      		syscall.Kill(-session.cmd.Process.Pid, syscall.SIGKILL)
      		session.Restart()
      		return fmt.Sprintf("Error: command did not finish within %d seconds", timeoutSeconds)
      	}
      }
      ```

      ```java Java
      // Run a command in the session, replacing the session if the command hangs.
      String executeWithTimeout(BashSession session, String command, int timeoutSeconds) throws Exception {
          ExecutorService pool = Executors.newSingleThreadExecutor();
          try {
              Future<String> future = pool.submit(() -> session.executeCommand(command));
              return future.get(timeoutSeconds, TimeUnit.SECONDS);
          } catch (TimeoutException e) {
              // Stop the shell and every process it started, then start a fresh session
              session.process.descendants().forEach(ProcessHandle::destroyForcibly);
              session.process.destroyForcibly();
              session.restart();
              return "Error: command did not finish within " + timeoutSeconds + " seconds";
          } finally {
              pool.shutdownNow();
          }
      }
      ```

      ```php PHP
      // Run a command but give up if it does not finish within the deadline. PHP blocks on
      // pipe reads, so the deadline lives inside the read loop: stream_select() waits for
      // readable output before each fgets() so the loop can check the deadline.
      function executeWithTimeout(BashSession $session, string $command, int $timeout = 30): string
      {
          $sentinel = '__CLAUDE_BASH_DONE_' . bin2hex(random_bytes(16)) . '__'; // unique per call
          fwrite($session->stdin, "{$command}\necho {$sentinel}\n");
          fflush($session->stdin);

          $deadline = microtime(true) + $timeout;
          $output = '';
          while (microtime(true) < $deadline) {
              $read = [$session->output];
              $write = null;
              $except = null;
              if (stream_select($read, $write, $except, 1) === 0) {
                  continue; // no output yet; check the deadline again
              }
              $line = fgets($session->output);
              if ($line === false || str_contains($line, $sentinel)) {
                  return $output; // this command's output is complete
              }
              $output .= $line;
          }

          // The group is the shell and every process the command started
          posix_kill(-proc_get_status($session->process)['pid'], 9); // 9 = SIGKILL
          $session->restart();
          return "Error: command did not finish within {$timeout} seconds";
      }
      ```

      ```ruby Ruby
      require "timeout"

      # Run a command in the session, replacing the session if the command hangs.
      def execute_with_timeout(session, command, timeout: 30)
        Timeout.timeout(timeout) { session.execute_command(command) }
      rescue Timeout::Error
        # The group is the shell and every process the command started
        Process.kill("KILL", -session.wait_thread.pid)
        session.restart
        "Error: command did not finish within #{timeout} seconds"
      end
      ```
    </CodeGroup>

    The kill stops the hung command and everything it started. Return the message as an error `tool_result` (see [Handle errors](https://platform.claude.com/docs/en/agents-and-tools/tool-use/bash-tool#handle-errors)), which marks the tool call as failed.
  </Accordion>

  <Accordion title="Maintain session state">
    Keep the bash session persistent to maintain environment variables and working directory:

    <CodeGroup exclude="shell">
      ```python Python
      # Commands run in the same session maintain state
      commands = [
          "cd /tmp",
          "echo 'Hello' > test.txt",
          "cat test.txt",  # The session is still in /tmp
      ]
      ```

      ```typescript TypeScript
      // Commands run in the same session maintain state
      const commands = [
        "cd /tmp",
        "echo 'Hello' > test.txt",
        "cat test.txt" // The session is still in /tmp
      ];
      ```

      ```csharp C#
      // Commands run in the same session maintain state
      string[] commands =
      [
          "cd /tmp",
          "echo 'Hello' > test.txt",
          "cat test.txt", // The session is still in /tmp
      ];
      ```

      ```go Go
      // Commands run in the same session maintain state
      commands := []string{
      	"cd /tmp",
      	"echo 'Hello' > test.txt",
      	"cat test.txt", // The session is still in /tmp
      }
      ```

      ```java Java
      // Commands run in the same session maintain state
      List<String> commands = List.of(
          "cd /tmp",
          "echo 'Hello' > test.txt",
          "cat test.txt" // The session is still in /tmp
      );
      ```

      ```php PHP
      // Commands run in the same session maintain state
      $commands = [
          'cd /tmp',
          "echo 'Hello' > test.txt",
          'cat test.txt', // The session is still in /tmp
      ];
      ```

      ```ruby Ruby
      # Commands run in the same session maintain state
      commands = [
        "cd /tmp",
        "echo 'Hello' > test.txt",
        "cat test.txt" # The session is still in /tmp
      ]
      ```
    </CodeGroup>
  </Accordion>

  <Accordion title="Handle large outputs">
    Truncate large outputs to prevent token limit issues:

    <CodeGroup exclude="shell">
      ```python Python
      def truncate_output(output, max_lines=100):
          lines = output.split("\n")
          if len(lines) > max_lines:
              truncated = "\n".join(lines[:max_lines])
              return f"{truncated}\n\n... Output truncated ({len(lines)} total lines) ..."
          return output
      ```

      ```typescript TypeScript
      function truncateOutput(output: string, maxLines = 100): string {
        const lines = output.split("\n");
        if (lines.length > maxLines) {
          const truncated = lines.slice(0, maxLines).join("\n");
          return `${truncated}\n\n... Output truncated (${lines.length} total lines) ...`;
        }
        return output;
      }
      ```

      ```csharp C#
      string TruncateOutput(string output, int maxLines = 100)
      {
          var lines = output.Split('\n');
          if (lines.Length > maxLines)
          {
              var truncated = string.Join("\n", lines.Take(maxLines));
              return $"{truncated}\n\n... Output truncated ({lines.Length} total lines) ...";
          }
          return output;
      }
      ```

      ```go Go
      func truncateOutput(output string, maxLines int) string {
      	lines := strings.Split(output, "\n")
      	if len(lines) > maxLines {
      		truncated := strings.Join(lines[:maxLines], "\n")
      		return fmt.Sprintf("%s\n\n... Output truncated (%d total lines) ...", truncated, len(lines))
      	}
      	return output
      }
      ```

      ```java Java
      String truncateOutput(String output, int maxLines) {
          String[] lines = output.split("\n", -1);
          if (lines.length > maxLines) {
              String truncated = String.join("\n", Arrays.copyOf(lines, maxLines));
              return truncated + "\n\n... Output truncated (" + lines.length + " total lines) ...";
          }
          return output;
      }
      ```

      ```php PHP
      function truncateOutput(string $output, int $maxLines = 100): string
      {
          $lines = explode("\n", $output);
          if (count($lines) > $maxLines) {
              $truncated = implode("\n", array_slice($lines, 0, $maxLines));
              return "{$truncated}\n\n... Output truncated (" . count($lines) . ' total lines) ...';
          }
          return $output;
      }
      ```

      ```ruby Ruby
      def truncate_output(output, max_lines: 100)
        lines = output.split("\n", -1)
        return output unless lines.length > max_lines

        truncated = lines.first(max_lines).join("\n")
        "#{truncated}\n\n... Output truncated (#{lines.length} total lines) ..."
      end
      ```
    </CodeGroup>
  </Accordion>

  <Accordion title="Log all commands">
    Keep an audit trail. Route every command through one wrapper that records the command before it runs and the output after it finishes. A command that hangs or breaks the session still leaves a record:

    <CodeGroup exclude="shell">
      ```python Python
      import logging

      logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")


      def execute_and_log(session, command):
          """Run a command in the session and keep an audit record of it."""
          logging.info("command=%r", command)
          output = session.execute_command(command)
          logging.info("output=%r", output[:200])  # first 200 characters
          return output
      ```

      ```typescript TypeScript
      // Run a command in the session and keep an audit record of it.
      async function executeAndLog(session: BashSession, command: string): Promise<string> {
        console.error(`command=${JSON.stringify(command)}`);
        const output = await session.executeCommand(command);
        console.error(`output=${JSON.stringify(output.slice(0, 200))}`); // first 200 characters
        return output;
      }
      ```

      ```csharp C#
      // Run a command in the session and keep an audit record of it.
      static string ExecuteAndLog(BashSession session, string command)
      {
          Console.Error.WriteLine($"command={command}");
          var output = session.ExecuteCommand(command);
          Console.Error.WriteLine($"output={output[..Math.Min(output.Length, 200)]}"); // first 200 characters
          return output;
      }
      ```

      ```go Go
      // executeAndLog runs a command in the session and keeps an audit record of it.
      func executeAndLog(session *BashSession, command string) string {
      	log.Printf("command=%q", command)
      	output := session.ExecuteCommand(command)
      	log.Printf("output=%q", output[:min(len(output), 200)]) // first 200 characters
      	return output
      }
      ```

      ```java Java
      static final Logger AUDIT = Logger.getLogger("bash-audit");

      // Run a command in the session and keep an audit record of it.
      String executeAndLog(BashSession session, String command) throws IOException {
          AUDIT.info("command=" + command);
          String output = session.executeCommand(command);
          AUDIT.info("output=" + output.substring(0, Math.min(output.length(), 200))); // first 200 characters
          return output;
      }
      ```

      ```php PHP
      // Run a command in the session and keep an audit record of it.
      function executeAndLog(BashSession $session, string $command): string
      {
          error_log("command={$command}");
          $output = $session->executeCommand($command);
          error_log('output=' . substr($output, 0, 200)); // first 200 characters
          return $output;
      }
      ```

      ```ruby Ruby
      require "logger"

      AUDIT = Logger.new($stderr)

      # Run a command in the session and keep an audit record of it.
      def execute_and_log(session, command)
        AUDIT.info("command=#{command.inspect}")
        output = session.execute_command(command)
        AUDIT.info("output=#{output[0, 200].inspect}") # first 200 characters
        output
      end
      ```
    </CodeGroup>

    The records go to `stderr` by default; point them at a file or your logging pipeline to keep them. Include whatever ties the record to the request in your application, such as the end user and the `tool_use_id`.
  </Accordion>
</AccordionGroup>

## Security

<Warning>
  Your application runs whatever command Claude requests. Run the session in an isolated environment, such as a container or a virtual machine, as the least-privileged user that can do the work. Treat every command as untrusted input.
</Warning>

Beyond isolation, add these controls:

* Validate commands before running them, with an allowlist rather than a blocklist. See [Implement the bash tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/bash-tool#implement-the-bash-tool).
* Set resource limits on the shell process (CPU, memory, and disk), for example with `ulimit`.
* Log every command and its output so you can audit what ran.
* Redact credentials and other secrets from output before returning it to Claude.

## Pricing

The bash tool definition adds the following input tokens to your request. This is in addition to the per-model [tool use system prompt](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview#pricing) that applies whenever any tool is present.

| Model                                               | Additional input tokens |
| --------------------------------------------------- | ----------------------- |
| Claude Opus 5, Claude Opus 4.8, and Claude Opus 4.7 | 325 tokens              |
| Claude Opus 4.6, Claude Sonnet 4.6, and earlier     | 244 tokens              |

Additional tokens are consumed by:

* Command outputs (stdout/stderr)
* Error messages
* Large file contents

See [tool use pricing](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview#pricing) for complete pricing details.

## Common patterns

### Development workflows

* Running tests: `pytest && coverage report`
* Building projects: `npm install && npm run build`
* Git operations: `git status && git add . && git commit -m "message"`

For guidance on using git as a checkpoint-and-recovery mechanism in long-running agent workflows, see [state management best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#state-management-best-practices).

### File operations

* Processing data: `wc -l *.csv && ls -lh *.csv`
* Searching files: `find . -name "*.py" | xargs grep "pattern"`
* Creating backups: `tar -czf backup.tar.gz ./data`

### System tasks

* Checking resources: `df -h && free -m`
* Process management: `ps aux | grep python`
* Environment setup: `export PATH=$PATH:/new/path && echo $PATH`

## Limitations

* **No interactive commands:** The session can't run `vim`, `less`, password prompts, or any command that waits for input on stdin.
* **No GUI applications:** The session is command-line only.
* **Session scope:** Bash session state is client-side. Your application is responsible for maintaining the shell session between turns.
* **Output limits:** The API doesn't truncate tool results (an oversized request is rejected). Truncate large outputs in your application before returning them to Claude.
* **No streaming:** Output reaches Claude only when your application returns the `tool_result` in the next request.

## Combining with other tools

The bash tool pairs well with the [Text editor tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool): Claude edits a file with one tool and requests the command that runs it with the other.

<Note>
  If you're also using the [Code execution tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool), Claude has access to two separate execution environments: your local bash session and Anthropic's sandboxed container. State is not shared between them. See [Using code execution with other execution tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool#using-code-execution-with-other-execution-tools) for guidance on prompting Claude to distinguish between environments.
</Note>

## Next steps

<CardGroup cols={2}>
  <Card title="Text editor tool" icon="file" href="https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool">
    View and modify text files to debug, fix, and improve code.
  </Card>

  <Card title="Tool use with Claude" icon="tool" href="https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview">
    Connect Claude to external tools and APIs. See where tools execute, when Claude calls them, and which tool fits your task.
  </Card>
</CardGroup>
