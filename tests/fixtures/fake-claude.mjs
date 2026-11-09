#!/usr/bin/env node
// A stand-in for Claude Code's `claude -p --output-format stream-json`, for
// the Ask bar's tests: it prints what the real one prints (an init event, tool
// calls, the structured answer, a result) as FAKE_CLAUDE says.
//   ok (default): reads a file, asks the map, answers
//   error: fails the way a signed-out CLI does
//   hang: never answers (the caller stops it)
//   prose: answers in prose without the schema
const mode = process.env.FAKE_CLAUDE ?? 'ok'
const args = process.argv.slice(2)
const say = e => process.stdout.write(`${JSON.stringify(e)}\n`)
const tool = (name, input) => say({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })
say({ type: 'system', subtype: 'init', session_id: 'fake', cwd: process.cwd(), tools: ['Read', 'Grep', 'Glob', 'Bash'] })
if (mode === 'hang') setInterval(() => {}, 1000)
else if (mode === 'error') {
  say({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Not logged in · Please run /login' })
} else if (mode === 'prose') {
  say({ type: 'result', subtype: 'success', is_error: false, result: 'It reads the shapes.' })
} else {
  tool('Read', { file_path: `${process.cwd()}/src/app.ts` })
  tool('Bash', { command: `node /x/main.ts query file src/util.ts --graph ${process.env.ARCHRIFT_QUERY_GRAPH}` })
  const answer = {
    title: 'How the app starts',
    answer: `[[src/app.ts]] calls [[s:src/shapes.ts#makeCircle]]; args: ${args.includes('--no-session-persistence') ? 'no session' : 'session'}, graph: ${process.env.ARCHRIFT_QUERY_GRAPH ? 'given' : 'none'}`,
    nodes: [
      { ref: 'src/app.ts', note: 'Starts it.' },
      { ref: 'src/nowhere.ts', note: 'Made up.' },
    ],
    steps: [
      { ref: 'src/app.ts', note: 'main runs' },
      { ref: 's:src/shapes.ts#makeCircle', note: 'a circle is made' },
    ],
    followUps: ['What else uses shapes?'],
  }
  tool('StructuredOutput', answer)
  say({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(answer), structured_output: answer })
}
