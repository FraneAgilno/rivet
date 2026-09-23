function visible(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, character =>
    `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`);
}

export function confirmIsolatedDependencyInstall(dependencies, signal) {
  return plan => {
    dependencies.output.log(`Install locked dependencies in ${visible(plan.worktreePath)}?`);
    dependencies.output.log(`Command: ${visible(plan.executable)} ${plan.args.map(visible).join(' ')}`);
    dependencies.output.log('Package installation may run scripts supplied by the project or its dependencies.');
    return dependencies.confirmDependencyInstall(plan, { signal });
  };
}
