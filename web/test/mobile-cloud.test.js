import { describe, it, expect } from 'vitest';
import {
  cloudSource, cloudSendBlock, picksOf, isCloudKind, cloudLabel, envChipLabel, repoChipLabel, folderChipLabel,
  toggleRepo, setBranch, groupRepos, accountHeaders, manageRows, splitRepo, mergeThreads, sessionSubline, sessionMark, toStoredMessages, defaultLocus,
} from '../src/mobile-cloud.ts';

// The phone's cloud lane (his direction, 2026-10-05): the web's labels and
// the web's locus rule, a GitHub repo as the hard limit on a cloud session.
const api = { id: '1', fullName: 'glyphh-ai/api', private: true, defaultBranch: 'main' };
const server = { id: '2', fullName: 'glyphh-ai/server', private: true, defaultBranch: 'glyphh-main' };
const other = { id: '3', fullName: 'acme/widgets', private: false, defaultBranch: 'master' };

describe('the cloud source', () => {
  it('is born from the picks — the FIRST pick is the repo the worker checks out, the rest ride along', () => {
    const picks = [{ repo: 'glyphh-ai/api', branch: 'main' }, { repo: 'glyphh-ai/server', branch: 'glyphh-main' }];
    expect(cloudSource(picks)).toEqual({ kind: 'cloud-repo', repo: 'glyphh-ai/api', branch: 'main', repos: picks, environmentId: 'default' });
  });
  it('is never born without a repo (GitHub is the hard limit)', () => {
    expect(cloudSource([])).toBeNull();
    expect(cloudSendBlock(false, [])).toBe('Connect GitHub to start a cloud session');
    expect(cloudSendBlock(true, [])).toBe('Choose a repository');
    expect(cloudSendBlock(true, [{ repo: 'glyphh-ai/api', branch: 'main' }])).toBe('');
  });
  it('reads its picks back from the record, old shape included', () => {
    expect(picksOf({ kind: 'cloud-repo', repo: 'glyphh-ai/api', branch: 'main', repos: [{ repo: 'glyphh-ai/api', branch: 'main' }] })).toEqual([{ repo: 'glyphh-ai/api', branch: 'main' }]);
    expect(picksOf({ kind: 'cloud-repo', repo: 'glyphh-ai/api' })).toEqual([{ repo: 'glyphh-ai/api', branch: '' }]);
    expect(picksOf(null)).toEqual([]);
    expect(picksOf({ kind: 'local', path: '/x' })).toEqual([]);
  });
  it('knows every cloud kind the web mints', () => {
    expect(isCloudKind('cloud-repo')).toBe(true);
    expect(isCloudKind('cloud-new')).toBe(true);
    expect(isCloudKind('cloud-space')).toBe(true);
    expect(isCloudKind('local')).toBe(false);
    expect(isCloudKind(undefined)).toBe(false);
  });
});

describe('labels', () => {
  it("wears the web's `Cloud · <repo>` (the last segment, code-source-chip.ts sourceLabel)", () => {
    expect(cloudLabel({ kind: 'cloud-repo', repo: 'glyphh-ai/api' })).toBe('Cloud · api');
    expect(cloudLabel({ kind: 'cloud-space', label: 'space 1' })).toBe('Cloud · space 1');
    expect(cloudLabel({ kind: 'cloud-new' })).toBe('Cloud');
    expect(cloudLabel(null)).toBe('Cloud');
  });
  it('names the environment chip Default in the cloud, the machine on a desktop', () => {
    expect(envChipLabel('cloud')).toBe('Default');
    expect(envChipLabel('local', 'Christophers-Mac-Studio')).toBe('Christophers-Mac-Studio');
    expect(envChipLabel('local')).toBe('Desktop');
  });
  it('counts repos and branches on the repo chip; Connect GitHub until linked', () => {
    expect(repoChipLabel([], false)).toBe('Connect GitHub');
    expect(repoChipLabel([], true)).toBe('Choose repositories');
    expect(repoChipLabel([{ repo: 'a/b', branch: 'main' }], true)).toBe('1 repo · 1 branch');
    expect(repoChipLabel([{ repo: 'a/b', branch: 'main' }, { repo: 'a/c', branch: 'dev' }], true)).toBe('2 repos · 2 branches');
    expect(folderChipLabel('/Users/x/development/yo')).toBe('yo');
    expect(folderChipLabel('')).toBe('Choose folder');
  });
});

describe('the repositories sheet', () => {
  it('toggles a pick, taking the default branch; order of picking is kept', () => {
    let picks = toggleRepo([], server);
    picks = toggleRepo(picks, api);
    expect(picks).toEqual([{ repo: 'glyphh-ai/server', branch: 'glyphh-main' }, { repo: 'glyphh-ai/api', branch: 'main' }]);
    expect(toggleRepo(picks, server)).toEqual([{ repo: 'glyphh-ai/api', branch: 'main' }]);
    expect(setBranch(picks, 'glyphh-ai/api', 'feat/x')[1]).toEqual({ repo: 'glyphh-ai/api', branch: 'feat/x' });
  });
  it('groups by account in the server\'s order (the member\'s own first), with a substring search across every account', () => {
    const g = groupRepos([server, other, api]);
    expect(g.map((x) => x.account)).toEqual(['glyphh-ai', 'acme']);
    expect(g[0].repos.map((r) => r.fullName)).toEqual(['glyphh-ai/api', 'glyphh-ai/server']);
    expect(groupRepos([server, other, api], 'SERV')).toEqual([{ account: 'glyphh-ai', repos: [server] }]);
    expect(splitRepo('glyphh-ai/api')).toEqual({ owner: 'glyphh-ai', name: 'api' });
    expect(accountHeaders([server, api])).toBe(false);
    expect(accountHeaders([server, other])).toBe(true);
    const mine = { id: '9002', account: 'timmetim', type: 'User', url: 'https://github.com/settings/installations/9002' };
    const org = { id: '9001', account: 'glyphh-ai', type: 'Organization', url: 'https://github.com/organizations/glyphh-ai/settings/installations/9001' };
    expect(manageRows({ installations: [mine, org] }).map((r) => r.url)).toEqual([mine.url, org.url]);
    expect(manageRows({ installations: [org] }).map((r) => [r.label, r.url])).toEqual([['Manage repository access…', org.url]]);
  });
});

describe('the sessions list', () => {
  const desk = (id, extra = {}) => ({ id, title: id, source: { kind: 'local', path: '/Users/x/yo', machineName: 'Mac' }, createdAt: 1, updatedAt: 2, messageCount: 1, ...extra });
  const cloud = (id) => ({ id, title: id, source: { kind: 'cloud-repo', repo: 'glyphh-ai/api' }, createdAt: 1, updatedAt: 2, messageCount: 1 });
  it('takes only the server CLOUD threads beside the desktop ones, never twice', () => {
    const merged = mergeThreads([desk('a'), desk('b')], [desk('a', { source: { kind: 'local' } }), cloud('c'), cloud('b')]);
    expect(merged.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(merged[1].source.kind).toBe('local');
  });
  it("sublines the folder's last segment on a desktop (else the age), Cloud · repo in the cloud", () => {
    expect(sessionSubline({ locus: 'local', path: '/Users/x/development/yo', age: '2d' })).toBe('yo');
    expect(sessionSubline({ locus: 'local', path: '', age: '2d' })).toBe('2d');
    expect(sessionSubline({ locus: 'cloud', source: { kind: 'cloud-repo', repo: 'glyphh-ai/api' }, age: '2d' })).toBe('Cloud · api');
  });
  it('marks a row idle / running / waiting', () => {
    expect(sessionMark(undefined)).toBe('idle');
    expect(sessionMark('working')).toBe('running');
    expect(sessionMark('waiting')).toBe('waiting');
  });
  it("defaults a new session to the attached desktop, else the cloud — the web's rule", () => {
    expect(defaultLocus('web', true)).toBe('local');
    expect(defaultLocus('web', false)).toBe('cloud');
  });
  it('stores the transcript as user/assistant text', () => {
    const out = toStoredMessages([{ role: 'user', text: 'hi' }, { role: 'glyphh', text: 'hello' }]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(out.every((m) => typeof m.at === 'number')).toBe(true);
  });
});

// NAMED ENVIRONMENTS (his direction, 2026-10-05: personal environments).
import {
  environmentIdOf, environmentName, environmentSubline, environmentFormError, parseDotenv, maskedDotenv, networkLabel,
  NETWORK_OPTIONS, DEFAULT_ENVIRONMENT_ID,
} from '../src/mobile-cloud.ts';

const staging = { id: 'e1', name: 'Staging', network: 'trusted', varCount: 2 };
const prod = { id: 'e2', name: 'Prod', network: 'none', varCount: 1 };

describe('the environment pick', () => {
  it('rides on the cloud source as environmentId, Default when none was named', () => {
    const picks = [{ repo: 'glyphh-ai/api', branch: 'main' }];
    expect(cloudSource(picks)).toMatchObject({ environmentId: 'default' });
    expect(cloudSource(picks, '')).toMatchObject({ environmentId: 'default' });
    expect(cloudSource(picks, 'e1')).toEqual({ kind: 'cloud-repo', repo: 'glyphh-ai/api', branch: 'main', repos: picks, environmentId: 'e1' });
    expect(cloudSource([], 'e1')).toBeNull();
  });
  it('reads back from the record; an older record without one is Default', () => {
    expect(environmentIdOf({ kind: 'cloud-repo', repo: 'a/b', environmentId: 'e1' })).toBe('e1');
    expect(environmentIdOf({ kind: 'cloud-repo', repo: 'a/b' })).toBe(DEFAULT_ENVIRONMENT_ID);
    expect(environmentIdOf({ environmentId: '' })).toBe('default');
    expect(environmentIdOf(null)).toBe('default');
  });
  it('names the chip: the picked row, Default for the built-in one or a pick that is gone', () => {
    expect(environmentName('e1', [staging, prod])).toBe('Staging');
    expect(environmentName('default', [staging])).toBe('Default');
    expect(environmentName(undefined, [staging])).toBe('Default');
    expect(environmentName('e9', [staging])).toBe('Default');
    expect(envChipLabel('cloud', undefined, 'Staging')).toBe('Staging');
    expect(envChipLabel('cloud')).toBe('Default');
    expect(envChipLabel('local', 'Mac', 'Staging')).toBe('Mac');
  });
  it('sublines a row with its policy and variable count', () => {
    expect(environmentSubline(staging)).toBe('Trusted network access · 2 variables');
    expect(environmentSubline(prod)).toBe('No network access · 1 variable');
    expect(environmentSubline({ network: 'full', varCount: 0 })).toBe('Full network access · 0 variables');
    expect(NETWORK_OPTIONS.map((o) => o.label)).toEqual(['No network access', 'Trusted network access', 'Full network access']);
    expect(networkLabel('bogus')).toBe('Full network access');
  });
});

describe('the .env text on the phone (the server reads it the same way)', () => {
  it('keeps the keys, skips blanks and comments, tolerates export, names a bad line by number', () => {
    expect(parseDotenv('# the API\nAPI_KEY=hunter2\nexport DB_URL=\'postgres://x\'\n\nPORT=8080 # note\nAPI_KEY=again\n')).toEqual({ ok: true, keys: ['API_KEY', 'DB_URL', 'PORT'] });
    expect(parseDotenv('')).toEqual({ ok: true, keys: [] });
    expect(parseDotenv('A=1\r\nB=2')).toEqual({ ok: true, keys: ['A', 'B'] });
    expect(parseDotenv('A=1\nno equals\nB=2')).toEqual({ ok: false, line: 2, error: 'Line 2: expected KEY=VALUE with a key like API_KEY' });
    expect(parseDotenv('1A=x')).toMatchObject({ ok: false, line: 1 });
    expect(parseDotenv('A B=x')).toMatchObject({ ok: false, line: 1 });
    expect(parseDotenv('A=1\n\n#c\n=x')).toMatchObject({ ok: false, line: 4 });
  });
  it('never keeps a value', () => {
    expect(JSON.stringify(parseDotenv('SECRET=hunter2'))).not.toContain('hunter2');
  });
  it('gates the form: a name, 60 chars at most, not Default, the vars parseable and within the caps', () => {
    expect(environmentFormError({ name: '', vars: '' })).toBe('Name the environment');
    expect(environmentFormError({ name: '   ', vars: '' })).toBe('Name the environment');
    expect(environmentFormError({ name: 'x'.repeat(61), vars: '' })).toBe('Names are 60 characters at most');
    expect(environmentFormError({ name: 'default', vars: '' })).toBe('Default is the built-in environment — pick another name');
    expect(environmentFormError({ name: 'Staging', vars: 'A=1\nbad' })).toBe('Line 2: expected KEY=VALUE with a key like API_KEY');
    expect(environmentFormError({ name: 'Staging', vars: Array.from({ length: 65 }, (_, i) => `K${i}=v`).join('\n') })).toBe('At most 64 variables');
    expect(environmentFormError({ name: 'Staging', vars: 'K=' + 'x'.repeat(32 * 1024) })).toBe('Environment variables are 32 KB at most');
    expect(environmentFormError({ name: 'Staging', vars: 'API_KEY=hunter2\n' })).toBe('');
    expect(environmentFormError({ name: 'Staging', vars: '' })).toBe('');
  });
  it('shows an edit as KEY=masked preview lines, which the parser also accepts', () => {
    const text = maskedDotenv([{ key: 'API_KEY', preview: 'hu•••••' }, { key: 'PORT', preview: '•••••' }]);
    expect(text).toBe('API_KEY=hu•••••\nPORT=•••••');
    expect(parseDotenv(text)).toEqual({ ok: true, keys: ['API_KEY', 'PORT'] });
    expect(maskedDotenv([])).toBe('');
  });
});
