// Ignore test stdout, diagnostics and error bodies. Only observed test outcomes cross
// the child-process boundary; the runner checks names against its fixed criteria.
export default async function* reporter(source) {
  for await (const event of source) {
    if (!['test:pass', 'test:fail'].includes(event.type)) continue;
    const data = event.data;
    yield `${JSON.stringify({ name: data.name,
      status: data.skip ? 'skipped' : data.todo ? 'todo' : event.type === 'test:pass' ? 'passed' : 'failed' })}\n`;
  }
}
