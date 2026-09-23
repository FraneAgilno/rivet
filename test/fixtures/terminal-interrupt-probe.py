"""Exercise the packaged CLI signal boundary with local fake tools in a real PTY."""
import json
import os
import pathlib
import pty
import select
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
STAGE = sys.argv[1]
SIGNAL = getattr(signal, sys.argv[2])


def wait_for_output(master, process, needle, timeout=15):
    output = ''
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.05)[0]:
            try:
                output += os.read(master, 65536).decode(errors='replace')
            except OSError:
                pass
            if needle in output:
                return output
        if process.poll() is not None:
            raise RuntimeError(f'CLI exited before {needle!r}: {output}')
    raise RuntimeError(f'CLI did not show {needle!r}: {output}')


def wait_for_file(master, process, file, timeout=20):
    deadline = time.monotonic() + timeout
    output = ''
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0)[0]:
            try:
                output += os.read(master, 65536).decode(errors='replace')
            except OSError:
                pass
        if file.exists():
            return
        if process.poll() is not None:
            raise RuntimeError(f'CLI exited before {file.name}: {output}')
        time.sleep(0.05)
    raise RuntimeError(f'CLI never reached {file.name}: {output}')


def wait_for_exit(master, process, timeout=20):
    deadline = time.monotonic() + timeout
    output = ''
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.05)[0]:
            try:
                output += os.read(master, 65536).decode(errors='replace')
            except OSError:
                pass
        if process.poll() is not None:
            return output
    raise RuntimeError(f'CLI did not exit: {output}')


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def start(node, root, env, args):
    master, slave = pty.openpty()
    process = subprocess.Popen([node, str(ROOT / 'bin/cli.js'), *args], cwd=root, env=env,
                               stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    return process, master


scratch = pathlib.Path(tempfile.mkdtemp(prefix='rivet-terminal-interrupt-'))
root = scratch / 'project'
root.mkdir()
shutil.copytree(ROOT / 'test/fixtures/config/valid/.rivet', root / '.rivet')
(root / 'package.json').write_text(json.dumps({'scripts': {'build': 'x', 'test': 'x', 'lint': 'x', 'typecheck': 'x', 'dev': 'x'}}))
(root / 'README.md').write_text('# signal fixture\n')
for args in [['init', '-q', '--initial-branch=main'], ['add', '.'],
             ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']]:
    subprocess.run(['git', '-C', str(root), *args], check=True, capture_output=True)
node = os.path.realpath(shutil.which('node'))
git = os.path.realpath(shutil.which('git'))
fake = scratch / 'codex'
gate = scratch / 'gate'
adapter_pid = scratch / 'adapter.pid'
adapter_beat = scratch / 'adapter.beat'
gate_pid = scratch / 'gate.pid'
gate_beat = scratch / 'gate.beat'
attempt = scratch / 'attempt'
version_calls = scratch / 'version-calls'
source = r'''#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const stage=STAGE;
if(process.argv.includes('--version')){
 if(stage==='probe-descendant'){
  const calls=fs.existsSync(VERSION_CALLS)?Number(fs.readFileSync(VERSION_CALLS,'utf8')):0;
  fs.writeFileSync(VERSION_CALLS,String(calls+1));
  if(calls>=2){hang();return;}
 }
 console.log('codex-cli 0.148.0-alpha.9');process.exit(0);
}
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
 const p=JSON.parse(input);
 if(p.kind==='agilno.feature-planning'){
  if(stage==='planning'||stage==='planning-descendant'){hang();return;}
  console.log(JSON.stringify({schemaVersion:1,kind:'agilno.feature-decomposition',workItems:[{objective:'Add greeting',ownedPaths:['app/greeting.js'],acceptanceCriterionIndexes:[1]}]}));return;
 }
 if(p.kind==='agilno.agent-launch'){
  if(stage==='worker'||stage==='worker-descendant'){hang();return;}
  if(stage==='resume'){
   if(fs.existsSync(ATTEMPT)){hang();return;}
   fs.writeFileSync(ATTEMPT,'started');
   console.log(JSON.stringify({version:1,status:'blocked',output:{summary:'Retry needed',evidence:[]},usage:{tokens:10,costUsd:0}}));return;
  }
  for(const owned of p.contract.ownedPaths){const target=path.join(p.contract.worktree.path,owned);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,'export const greeting="Hello";\n');}
  console.log(JSON.stringify({version:1,status:'success',output:{summary:'Added greeting',evidence:p.contract.evidence},usage:{tokens:10,costUsd:0}}));return;
 }
 process.exit(2);
});
function hang(){
 if(stage.endsWith('-descendant')){
  const code=`const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(${JSON.stringify(BEAT)},'tick\\n'),100);`;
  const descendant=spawn(process.execPath,['-e',code],{stdio:'ignore'});
  fs.writeFileSync(PIDFILE,String(descendant.pid));
  setInterval(()=>{},1000);
  return;
 }
 fs.writeFileSync(PIDFILE,String(process.pid));setInterval(()=>fs.appendFileSync(BEAT,'tick\n'),100);
}
'''.replace('STAGE', json.dumps(STAGE)).replace('PIDFILE', json.dumps(str(adapter_pid))).replace('BEAT', json.dumps(str(adapter_beat))).replace('ATTEMPT', json.dumps(str(attempt))).replace('VERSION_CALLS', json.dumps(str(version_calls)))
fake.write_text(source)
fake.chmod(0o700)
if STAGE in ('gate-descendant', 'gate-descendant-pid'):
    descendant = ('import signal,time,pathlib\n'
                  'signal.signal(signal.SIGTERM,signal.SIG_IGN)\n'
                  f'p=pathlib.Path({str(gate_beat)!r})\n'
                  'while True:\n p.open("a").write("tick\\n"); time.sleep(.1)\n')
    gate.write_text('#!/bin/sh\n' + shlex.quote(sys.executable) + ' -c ' + shlex.quote(descendant)
                    + ' </dev/null >/dev/null 2>&1 &\nprintf "%s" "$!" > ' + shlex.quote(str(gate_pid))
                    + '\nwhile true; do sleep .1; done\n')
else:
    gate.write_text('#!/bin/sh\nprintf "%s" "$$" > ' + str(gate_pid) + '\nwhile true; do printf tick >> ' + str(gate_beat) + '; sleep .1; done\n')
gate.chmod(0o700)
env = dict(os.environ, RIVET_CODEX_EXECUTABLE=str(fake), RIVET_CODEX_INTERPRETER=node,
           RIVET_GIT_EXECUTABLE=git, RIVET_NPM_EXECUTABLE=str(gate))
processes = []
try:
    process, master = start(node, root, env, ['run', 'Add a greeting', '--harness=codex'])
    processes.append((process, master))
    if STAGE in ('planning', 'planning-descendant', 'probe-descendant'):
        marker, heartbeat = adapter_pid, adapter_beat
    else:
        wait_for_output(master, process, '[y/N]')
        if STAGE == 'approval':
            os.killpg(process.pid, SIGNAL)
            wait_for_exit(master, process)
            assert process.returncode == 6, process.returncode
            assert not adapter_pid.exists()
            runs = list((root / '.git/rivet/feature-runs').glob('*/run.json'))
            assert len(runs) == 1
            assert json.loads(runs[0].read_text())['data']['status'] == 'proposed'
            print(json.dumps({'stage': STAGE, 'signal': SIGNAL.name, 'cli_returncode': process.returncode,
                              'activated': False}))
            sys.exit(0)
        time.sleep(0.1)
        os.write(master, b'y\r')
        if STAGE == 'resume':
            wait_for_exit(master, process)
            assert process.returncode != 0
            runs = list((root / '.git/rivet/feature-runs').glob('*/run.json'))
            assert len(runs) == 1
            assert json.loads(runs[0].read_text())['data']['status'] == 'blocked'
            process, master = start(node, root, env, ['task', 'resume'])
            processes.append((process, master))
            marker, heartbeat = adapter_pid, adapter_beat
        elif STAGE in ('worker', 'worker-descendant'):
            marker, heartbeat = adapter_pid, adapter_beat
        else:
            marker, heartbeat = gate_pid, gate_beat
    wait_for_file(master, process, marker)
    child_pid = int(marker.read_text())
    time.sleep(0.2)
    if STAGE == 'gate-descendant-pid':
        os.kill(process.pid, SIGNAL)
    else:
        os.killpg(process.pid, SIGNAL)
    wait_for_exit(master, process)
    before = heartbeat.stat().st_size
    time.sleep(0.5)
    after = heartbeat.stat().st_size
    assert process.returncode == 6, process.returncode
    assert not alive(child_pid), f'child {child_pid} survived'
    assert before == after, (before, after)
    if STAGE in ('worker', 'worker-descendant', 'gate', 'gate-descendant', 'gate-descendant-pid', 'resume'):
        runs = list((root / '.git/rivet/feature-runs').glob('*/run.json'))
        assert len(runs) == 1
        assert json.loads(runs[0].read_text())['data']['status'] == 'blocked'
        if STAGE in ('gate', 'gate-descendant', 'gate-descendant-pid'):
            report = runs[0].parent / 'verification.json'
            assert json.loads(report.read_text())['data']['status'] == 'fail'
    print(json.dumps({'stage': STAGE, 'signal': SIGNAL.name, 'cli_returncode': process.returncode,
                      'child_survived': False, 'heartbeat_before': before, 'heartbeat_after': after}))
finally:
    for marker in [adapter_pid, gate_pid]:
        if marker.exists():
            try:
                os.kill(int(marker.read_text()), signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                os.killpg(int(marker.read_text()), signal.SIGKILL)
            except ProcessLookupError:
                pass
    for process, master in processes:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        os.close(master)
    shutil.rmtree(scratch)
