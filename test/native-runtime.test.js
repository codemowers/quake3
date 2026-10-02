import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import dgram from 'node:dgram';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';

function serverInfo() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('UDP response timed out'));
    }, 1000);
    socket.once('error', (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
    socket.once('message', (message) => {
      clearTimeout(timer);
      socket.close();
      resolve(message.subarray(4).toString());
    });
    socket.send(Buffer.concat([Buffer.from([255, 255, 255, 255]), Buffer.from('getinfo smoke')]), 27961, '127.0.0.1');
  });
}

for (const wildcard of [false, true]) {
  test(`native server reads separate assets/config and binds ${wildcard ? 'all interfaces' : 'loopback'}`, {
    skip: !process.env.Q3_NATIVE_BINARY && 'Set Q3_NATIVE_BINARY and mount native assets plus retail game data',
    timeout: 15000
  }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quake3-native-'));
    const configPath = path.join(directory, 'config');
    const statePath = path.join(directory, 'state');
    fs.mkdirSync(path.join(configPath, 'baseq3'), {recursive: true});
    fs.mkdirSync(path.join(statePath, 'baseq3'), {recursive: true});
    fs.writeFileSync(path.join(statePath, 'baseq3', 'server.cfg'), 'set sv_hostname WRONG_CONFIG\n');
    const config = [
      `set net_ip "${wildcard ? '0.0.0.0' : '127.0.0.1'}"`,
      `set net_ip6 "${wildcard ? '::' : '::1'}"`,
      'net_restart',
      'set sv_hostname direct-runtime-test',
      'set sv_pure 0',
      'set g_password SMOKEPASS',
      'set rotation0 "map q3dm17; set nextmap vstr rotation1"',
      'set rotation1 "map q3dm1; set nextmap vstr rotation0"',
      'vstr rotation0',
      ''
    ].join('\n');
    const configFile = path.join(configPath, 'baseq3', 'server.cfg');
    fs.writeFileSync(configFile, config, {mode: 0o444});
    const assetPath = path.dirname(process.env.Q3_NATIVE_BINARY);
    const child = spawn(process.env.Q3_NATIVE_BINARY, [
      '+set', 'dedicated', '1',
      '+set', 'fs_basepath', process.env.Q3_TEST_DATA_PATH || '/data',
      '+set', 'fs_assetpath', assetPath,
      '+set', 'fs_configpath', configPath,
      '+set', 'fs_homepath', statePath,
      '+set', 'fs_debug', '1',
      '+set', 'net_enabled', '11',
      '+set', 'net_ip', '127.0.0.1',
      '+set', 'net_ip6', '::1',
      '+set', 'net_port', '27961',
      '+set', 'net_port6', '27961',
      '+exec', 'server.cfg'
    ], {stdio: ['pipe', 'pipe', 'pipe']});
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      fs.rmSync(directory, {recursive: true, force: true});
    });
    for (let attempt = 0; attempt < 100 && !output.includes('==== ShutdownGame ====') && !output.includes('----- Server Initialization -----'); attempt++) {
      assert.equal(child.exitCode, null, output);
      await delay(50);
    }
    await delay(500);
    assert.equal(child.exitCode, null, output);
    for (const [index, map] of ['q3dm17', 'q3dm1', 'q3dm17'].entries()) {
      if (index) {
        child.stdin.write('vstr nextmap\n');
        await delay(700);
      }
      const info = await serverInfo();
      assert.ok(info.includes(`\\mapname\\${map}`), info);
      assert.ok(info.includes('\\hostname\\direct-runtime-test'), info);
      assert.ok(info.includes('\\g_needpass\\1'), info);
    }
    const sockets = ['/proc/net/udp', '/proc/net/udp6'].flatMap((file) =>
      fs.readFileSync(file, 'utf8').trim().split('\n').slice(1).map((line) => line.trim().split(/\s+/)[1])
    ).filter((address) => address.endsWith(':6D39'));
    assert.deepEqual(sockets.sort(), (wildcard
      ? ['00000000:6D39', '00000000000000000000000000000000:6D39']
      : ['0100007F:6D39', '00000000000000000000000001000000:6D39']).sort());
    assert.ok(output.includes(`found in '${assetPath}/baseq3'`), output);
    assert.equal(fs.existsSync(path.join(statePath, 'baseq3', 'vm')), false);
    assert.equal(fs.readFileSync(configFile, 'utf8'), config);
    assert.equal(output.includes('SMOKEPASS'), false);
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    assert.deepEqual(await exit, [1, null]);
  });
}
