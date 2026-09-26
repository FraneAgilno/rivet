import { createInterface } from 'node:readline/promises';

// The guide asks only for local metadata and environment variable names. It has
// no secret-input mode and never reads credentials or contacts a provider.
export async function defaultIntegrationSetupPrompt(question) {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  let timer;
  try {
    let prompt = question.message;
    if (question.type === 'select' || question.type === 'multi') {
      prompt += '\n' + question.choices.map((choice, index) => `  ${index + 1}. ${choice.label}`).join('\n');
      prompt += question.type === 'multi' ? '\nNumbers separated by commas (blank to cancel): ' : '\nNumber (blank to cancel): ';
    } else if (question.type === 'confirm') prompt += ' [y/N] ';
    else prompt += question.defaultValue ? ` [${question.defaultValue}] (q to cancel): ` : ' (blank to cancel): ';
    const answer = String(await Promise.race([
      readline.question(prompt),
      new Promise(resolve => { timer = setTimeout(() => resolve('q'), 120000); }),
    ])).trim();
    if (answer.toLowerCase() === 'q') return null;
    if (question.type === 'confirm') return /^(?:y|yes)$/i.test(answer);
    if (question.type === 'input') return answer || question.defaultValue || null;
    if (!answer) return null;
    const parts = answer.split(',').map(value => value.trim());
    if (parts.some(value => !/^[1-9][0-9]*$/.test(value))) return null;
    const indexes = parts.map(value => Number(value) - 1);
    if (indexes.some(index => !Number.isSafeInteger(index) || index >= question.choices.length)
      || new Set(indexes).size !== indexes.length || (question.type === 'select' && indexes.length !== 1)) return null;
    const selected = indexes.map(index => question.choices[index].value);
    return question.type === 'select' ? selected[0] : selected;
  } catch { return null; }
  finally { clearTimeout(timer); readline.close(); }
}
