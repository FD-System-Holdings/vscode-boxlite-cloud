import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DomainsTreeDataProvider } from '../src/tree/domainsProvider';
import { DomainTreeItem, DomainAllowanceTreeItem } from '../src/tree/nodes';
import { DomainItem } from '../src/bridge/protocol';
import { validateCustomDomain, validatePlatformSubdomain } from '../src/util/validation';
import { registerCommands } from '../src/commands';

describe('Domains Support', () => {
  const pkgPath = path.resolve(__dirname, '../../package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

  it('places boxlite.domainsView strictly under boxlite.boxesView and above boxlite.secretsView', () => {
    const views: Array<{ id: string; name: string }> = pkg.contributes.views['boxlite-explorer'];
    const boxesIdx = views.findIndex((v) => v.id === 'boxlite.boxesView');
    const domainsIdx = views.findIndex((v) => v.id === 'boxlite.domainsView');
    const secretsIdx = views.findIndex((v) => v.id === 'boxlite.secretsView');

    assert.ok(boxesIdx >= 0, 'boxlite.boxesView must exist');
    assert.ok(domainsIdx >= 0, 'boxlite.domainsView must exist');
    assert.ok(secretsIdx >= 0, 'boxlite.secretsView must exist');
    assert.strictEqual(domainsIdx, boxesIdx + 1, 'boxlite.domainsView must appear immediately under boxlite.boxesView');
    assert.strictEqual(secretsIdx, domainsIdx + 1, 'boxlite.domainsView must appear immediately above boxlite.secretsView');
    assert.strictEqual(views[domainsIdx].name, 'Domains');
  });

  it('registers all domain commands and view/title + view/item/context menus', () => {
    const commands = pkg.contributes.commands as Array<{ command: string; title: string }>;
    const commandMap = new Map(commands.map((c) => [c.command, c.title]));
    const expected: Array<[string, string]> = [
      ['boxlite.refreshDomains', 'Refresh Domains'],
      ['boxlite.createDomain', 'Request Domain...'],
      ['boxlite.verifyDomain', 'Verify Domain'],
      ['boxlite.bindDomainToBox', 'Bind Domain to Box...'],
      ['boxlite.openDomainUrl', 'Open Domain in Browser'],
      ['boxlite.copyDomainName', 'Copy Domain Name'],
      ['boxlite.inspectDomain', 'Inspect Domain (JSON)'],
      ['boxlite.unbindDomain', 'Unbind Domain']
    ];
    for (const [cmd, title] of expected) {
      assert.strictEqual(commandMap.get(cmd), title, `Expected command ${cmd} with title "${title}" in package.json`);
    }
    assert.ok(!commandMap.has('boxlite.deleteDomain'), 'Removed broken deleteDomain command');

    const titleMenus: Array<{ command: string; when?: string }> = pkg.contributes.menus['view/title'] || [];
    assert.ok(titleMenus.some((m) => m.command === 'boxlite.refreshDomains' && m.when === 'view == boxlite.domainsView'));
    assert.ok(titleMenus.some((m) => m.command === 'boxlite.createDomain' && m.when === 'view == boxlite.domainsView'));

    const itemMenus: Array<{ command: string; when?: string }> = pkg.contributes.menus['view/item/context'] || [];
    for (const cmd of [
      'boxlite.verifyDomain',
      'boxlite.bindDomainToBox',
      'boxlite.openDomainUrl',
      'boxlite.copyDomainName',
      'boxlite.inspectDomain',
      'boxlite.unbindDomain'
    ]) {
      assert.ok(
        itemMenus.some((m) => m.command === cmd && m.when?.includes('view == boxlite.domainsView')),
        `Expected ${cmd} in view/item/context for boxlite.domainsView`
      );
    }
  });

  describe('validatePlatformSubdomain', () => {
    it('accepts valid short names and strips configured suffix if provided', () => {
      const shortRes = validatePlatformSubdomain('  My-Service ', { minLength: 5, domainSuffix: 'boxliteapp.com' });
      assert.strictEqual(shortRes.valid, true);
      assert.strictEqual(shortRes.shortName, 'my-service');
      assert.strictEqual(shortRes.fullDomain, 'my-service.boxliteapp.com');

      const fullRes = validatePlatformSubdomain('fd-system-holdings.boxliteapp.com.', {
        minLength: 5,
        domainSuffix: 'boxliteapp.com'
      });
      assert.strictEqual(fullRes.valid, true);
      assert.strictEqual(fullRes.shortName, 'fd-system-holdings');
      assert.strictEqual(fullRes.fullDomain, 'fd-system-holdings.boxliteapp.com');
    });

    it('rejects short names below minLength, reserved labels, legacy digit-dash prefixes, and custom domains', () => {
      const tooShort = validatePlatformSubdomain('abc', { minLength: 5, domainSuffix: 'boxliteapp.com' });
      assert.strictEqual(tooShort.valid, false);
      assert.ok(tooShort.error?.includes('5'));

      assert.strictEqual(validatePlatformSubdomain('api').valid, false);
      assert.strictEqual(validatePlatformSubdomain('domains').valid, false);
      assert.strictEqual(validatePlatformSubdomain('3000-mybox').valid, false);
      assert.strictEqual(validatePlatformSubdomain('-bad').valid, false);
      assert.strictEqual(validatePlatformSubdomain('bad-').valid, false);
      assert.strictEqual(validatePlatformSubdomain('app.example.com').valid, false);
      assert.strictEqual(validatePlatformSubdomain('https://demo.boxliteapp.com').valid, false);
    });
  });

  describe('validateCustomDomain', () => {
    it('accepts and normalizes valid FQDNs', () => {
      const res = validateCustomDomain('  App.Example.COM. ');
      assert.strictEqual(res.valid, true);
      assert.strictEqual(res.normalized, 'app.example.com');
    });

    it('rejects empty, schemes, paths, ports, wildcards, and IPv4', () => {
      assert.strictEqual(validateCustomDomain('').valid, false);
      assert.strictEqual(validateCustomDomain('https://app.example.com').valid, false);
      assert.strictEqual(validateCustomDomain('app.example.com/api').valid, false);
      assert.strictEqual(validateCustomDomain('app.example.com:8080').valid, false);
      assert.strictEqual(validateCustomDomain('*.example.com').valid, false);
      assert.strictEqual(validateCustomDomain('192.168.1.10').valid, false);
      assert.strictEqual(validateCustomDomain('localhost').valid, false);
    });

    it('warns on platform-managed boxlite.ai subdomains', () => {
      const res = validateCustomDomain('demo.boxlite.ai');
      assert.strictEqual(res.valid, true);
      assert.ok(res.warning && res.warning.includes('boxlite.ai'));
    });
  });

  it('formats DomainTreeItem across active, unbound, pending, failed, and deleting states', () => {
    const active = new DomainTreeItem({
      id: 'dom_1',
      domain: 'app.boxliteapp.com',
      kind: 'platform',
      url: 'https://app.boxliteapp.com',
      status: 'active',
      boxId: 'box_1',
      boxName: 'web-api',
      port: 8080
    });
    assert.strictEqual(active.label, 'app.boxliteapp.com');
    assert.strictEqual(active.description, 'active · → web-api:8080');
    assert.strictEqual(active.contextValue, 'domain-active');

    const unbound = new DomainTreeItem({
      id: 'fd-system-holdings.boxliteapp.com',
      domain: 'fd-system-holdings.boxliteapp.com',
      kind: 'platform',
      status: 'unbound'
    });
    assert.strictEqual(unbound.description, 'unbound · reserved');
    assert.strictEqual(unbound.contextValue, 'domain-unbound');

    const pending = new DomainTreeItem({
      id: 'dom_2',
      domain: 'api.example.com',
      kind: 'custom',
      status: 'pending'
    });
    assert.strictEqual(pending.description, 'pending · unattached');
    assert.strictEqual(pending.contextValue, 'domain-pending');

    const failed = new DomainTreeItem({
      id: 'dom_3',
      domain: 'bad.example.com',
      status: 'failed',
      errorReason: 'TXT mismatch'
    });
    assert.strictEqual(failed.contextValue, 'domain-failed');
    assert.ok(String(failed.tooltip).includes('TXT mismatch'));

    const deleting = new DomainTreeItem({
      id: 'dom_4',
      domain: 'old.example.com',
      status: 'deleting'
    });
    assert.strictEqual(deleting.contextValue, 'domain-deleting');
  });

  it('handles DomainsTreeDataProvider allowance, unbound platform domains without polling, bound children, and errors', async () => {
    let apiKey: string | undefined = undefined;
    let domainsToReturn: DomainItem[] = [];
    let allowanceToReturn: any = { limit: 5, used: 0, remaining: 5, minLength: 5, domainSuffix: 'boxliteapp.com' };
    let listError: Error | undefined = undefined;

    const mockBridge: any = {
      listDomainsWithAllowance: async () => {
        if (listError) throw listError;
        return { domains: domainsToReturn, allowance: allowanceToReturn };
      },
      listDomains: async () => {
        if (listError) throw listError;
        return domainsToReturn;
      }
    };
    const mockCreds: any = {
      getApiKey: async () => apiKey
    };

    const provider = new DomainsTreeDataProvider(mockBridge, mockCreds);

    // Startup gate
    provider.setStartupReady(false);
    assert.deepStrictEqual(await provider.getChildren(), []);
    provider.setStartupReady(true);

    // Signed out
    const signedOut = await provider.getChildren();
    assert.strictEqual(signedOut.length, 1);
    assert.strictEqual(signedOut[0].label, 'Sign in to BoxLite Cloud');

    // Empty with allowance
    apiKey = 'blk_live_test';
    const empty = await provider.getChildren();
    assert.strictEqual(empty.length, 2);
    assert.ok(empty[0] instanceof DomainAllowanceTreeItem);
    assert.strictEqual(empty[0].label, '0 of 5 platform domains');
    assert.strictEqual(empty[1].label, 'No Domains Reserved');

    // Unbound platform domain: must NOT schedule polling timer and must NOT show "Verify DNS"
    domainsToReturn = [
      {
        id: 'fd-system-holdings.boxliteapp.com',
        domain: 'fd-system-holdings.boxliteapp.com',
        kind: 'platform',
        url: 'https://fd-system-holdings.boxliteapp.com',
        status: 'unbound'
      }
    ];
    allowanceToReturn = { limit: 5, used: 1, remaining: 4, minLength: 5, domainSuffix: 'boxliteapp.com' };
    const unboundRoot = await provider.getChildren();
    assert.strictEqual((provider as any).refreshTimer, undefined, 'Unbound platform domains must not trigger polling');
    assert.ok(unboundRoot[1] instanceof DomainTreeItem);
    const unboundChildren = await provider.getChildren(unboundRoot[1]);
    const unboundLabels = unboundChildren.map((c) => c.label);
    assert.ok(unboundLabels.includes('Status'));
    assert.ok(unboundLabels.includes('Type'));
    assert.ok(unboundLabels.includes('Target Box'));
    assert.ok(!unboundLabels.includes('Verify DNS'), 'Platform domain must not show Verify DNS');

    // Bound platform domain: shows Verify Routing, Open in Browser, and Unbind from Box
    domainsToReturn = [
      {
        id: 'live-app.boxliteapp.com',
        domain: 'live-app.boxliteapp.com',
        kind: 'platform',
        url: 'https://live-app.boxliteapp.com',
        status: 'active',
        boxId: 'box_1',
        boxName: 'web',
        port: 8080
      }
    ];
    const activeRoot = await provider.getChildren();
    const activeChildren = await provider.getChildren(activeRoot[1]);
    const activeLabels = activeChildren.map((c) => c.label);
    assert.ok(activeLabels.includes('Verify Routing'));
    assert.ok(activeLabels.includes('Open in Browser'));
    assert.ok(activeLabels.includes('Unbind from Box'));

    // 404/501 unavailable server error
    listError = new Error('HTTP 404 Not Found');
    const err404 = await provider.getChildren();
    assert.strictEqual(err404.length, 1);
    assert.strictEqual(err404[0].contextValue, 'domain-unavailable');
    provider.dispose();
  });

  describe('Domain Command Handlers', () => {
    const origRegisterCommand = vscode.commands.registerCommand;
    const origShowInputBox = vscode.window.showInputBox;
    const origShowQuickPick = vscode.window.showQuickPick;
    const origShowInfo = vscode.window.showInformationMessage;
    const origShowWarning = vscode.window.showWarningMessage;
    const origWithProgress = vscode.window.withProgress;

    afterEach(() => {
      (vscode.commands as any).registerCommand = origRegisterCommand;
      (vscode.window as any).showInputBox = origShowInputBox;
      (vscode.window as any).showQuickPick = origShowQuickPick;
      (vscode.window as any).showInformationMessage = origShowInfo;
      (vscode.window as any).showWarningMessage = origShowWarning;
      (vscode.window as any).withProgress = origWithProgress;
    });

    it('executes createDomain (claim + publish + bind), verifyDomain (unbound + bound + 404 quick-fix), bindDomainToBox, and unbindDomain flows', async () => {
      const handlers = new Map<string, (...args: any[]) => any>();
      (vscode.commands as any).registerCommand = (cmd: string, fn: (...args: any[]) => any) => {
        handlers.set(cmd, fn);
        return { dispose() {} };
      };
      (vscode.window as any).withProgress = async (_opts: any, task: any) => task({ report() {} });

      let createdPayload: any;
      let verifiedKey: string | undefined;
      let boundPayload: any;
      let unboundKey: string | undefined;
      const inboundCalls: Array<[string, string]> = [];
      const tunnelCalls: Array<[string, number, boolean]> = [];
      const revokeCalls: Array<[string, number]> = [];
      let refreshCount = 0;

      let verifyReturn: DomainItem = {
        id: 'fd-system-holdings.boxliteapp.com',
        domain: 'fd-system-holdings.boxliteapp.com',
        kind: 'platform',
        status: 'unbound',
        reachable: false,
        verificationSummary: 'Domain "fd-system-holdings.boxliteapp.com" is owned and ready.'
      };

      const mockBridge: any = {
        listBoxes: async () => [{ id: 'box_1', name: 'api-box', status: 'running' }],
        listDomainsWithAllowance: async () => ({
          domains: [
            {
              id: 'fd-system-holdings.boxliteapp.com',
              domain: 'fd-system-holdings.boxliteapp.com',
              kind: 'platform',
              status: 'unbound'
            }
          ],
          allowance: { limit: 5, used: 1, remaining: 4, minLength: 5, domainSuffix: 'boxliteapp.com' }
        }),
        listDomains: async () => [
          {
            id: 'fd-system-holdings.boxliteapp.com',
            domain: 'fd-system-holdings.boxliteapp.com',
            kind: 'platform',
            status: 'unbound'
          }
        ],
        createDomain: async (args: any) => {
          createdPayload = args;
          return {
            id: `${args.domain}.boxliteapp.com`,
            domain: `${args.domain}.boxliteapp.com`,
            url: `https://${args.domain}.boxliteapp.com`,
            kind: 'platform',
            status: 'unbound'
          };
        },
        updateInbound: async (boxId: string, mode: string) => {
          inboundCalls.push([boxId, mode]);
        },
        tunnel: async (boxId: string, port: number, isPublic: boolean) => {
          tunnelCalls.push([boxId, port, isPublic]);
          return { boxId, port, isPublic, url: 'https://tunnel.boxliteapp.com' };
        },
        revokeTunnel: async (boxId: string, port: number) => {
          revokeCalls.push([boxId, port]);
          return true;
        },
        bindDomain: async (args: any) => {
          boundPayload = args;
          return {
            id: args.domainKey,
            domain: args.domainKey,
            url: `https://${args.domainKey}`,
            kind: 'platform',
            status: 'active',
            boxId: args.boxId,
            port: args.port
          };
        },
        unbindDomain: async (key: string) => {
          unboundKey = key;
          return { domainKey: key, unbound: true };
        },
        verifyDomain: async (key: string) => {
          verifiedKey = key;
          return verifyReturn;
        }
      };

      const mockCreds: any = { getApiKey: async () => 'blk_live_test' };
      const mockDomainsProvider: any = { refresh: () => { refreshCount++; } };

      registerCommands(
        { subscriptions: [] } as any,
        mockBridge,
        mockCreds,
        {} as any,
        { refresh() {} } as any,
        {} as any,
        {} as any,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        mockDomainsProvider
      );

      const infoMessages: string[] = [];
      const warnMessages: string[] = [];
      (vscode.window as any).showInformationMessage = async (msg: string) => {
        infoMessages.push(msg);
        return undefined;
      };
      (vscode.window as any).showWarningMessage = async (msg: string) => {
        warnMessages.push(msg);
        return undefined;
      };

      // 1. createDomain (claims short label, enables inbound + public tunnel, and binds)
      let inputStep = 0;
      (vscode.window as any).showInputBox = async () => (inputStep++ === 0 ? 'my-service' : '8080');
      (vscode.window as any).showQuickPick = async (items: any[]) => items[1]; // api-box
      await handlers.get('boxlite.createDomain')!();
      assert.deepStrictEqual(createdPayload, { domain: 'my-service' });
      assert.deepStrictEqual(inboundCalls[0], ['box_1', 'enabled']);
      assert.deepStrictEqual(tunnelCalls[0], ['box_1', 8080, true]);
      assert.deepStrictEqual(boundPayload, {
        domainKey: 'my-service.boxliteapp.com',
        boxId: 'box_1',
        port: 8080
      });

      // 2. verifyDomain on unbound platform domain
      const item = new DomainTreeItem({
        id: 'fd-system-holdings.boxliteapp.com',
        domain: 'fd-system-holdings.boxliteapp.com',
        kind: 'platform',
        status: 'unbound'
      });
      await handlers.get('boxlite.verifyDomain')!(item);
      assert.strictEqual(verifiedKey, 'fd-system-holdings.boxliteapp.com');
      assert.ok(infoMessages.some((m) => m.includes('owned and ready')));

      // 2b. verifyDomain when bound port returns 404 offers one-click tunnel repair
      verifyReturn = {
        id: 'fd-system-holdings.boxliteapp.com',
        domain: 'fd-system-holdings.boxliteapp.com',
        status: 'active',
        boxId: 'box_1',
        port: 8080,
        httpStatus: 404,
        reachable: false,
        verificationSummary: 'Domain returned HTTP 404.'
      };
      (vscode.window as any).showWarningMessage = async (msg: string) => {
        warnMessages.push(msg);
        return 'Enable Inbound & Public Tunnel';
      };
      await handlers.get('boxlite.verifyDomain')!(item);
      assert.strictEqual(inboundCalls.length, 2);
      assert.strictEqual(tunnelCalls.length, 2);

      // 3. bindDomainToBox
      (vscode.window as any).showQuickPick = async (items: any[]) => items[0]; // api-box
      (vscode.window as any).showInputBox = async () => '3000';
      await handlers.get('boxlite.bindDomainToBox')!(item);
      assert.deepStrictEqual(boundPayload, {
        domainKey: 'fd-system-holdings.boxliteapp.com',
        boxId: 'box_1',
        port: 3000
      });

      // 4. unbindDomain with optional tunnel revoke
      const boundItem = new DomainTreeItem({
        id: 'fd-system-holdings.boxliteapp.com',
        domain: 'fd-system-holdings.boxliteapp.com',
        status: 'active',
        boxId: 'box_1',
        port: 3000
      });
      (vscode.window as any).showWarningMessage = async () => 'Unbind';
      (vscode.window as any).showInformationMessage = async (msg: string) => {
        infoMessages.push(msg);
        return 'Revoke Port Tunnel';
      };
      await handlers.get('boxlite.unbindDomain')!(boundItem);
      assert.strictEqual(unboundKey, 'fd-system-holdings.boxliteapp.com');
      assert.deepStrictEqual(revokeCalls, [['box_1', 3000]]);
      assert.ok(refreshCount >= 4);
      assert.ok(infoMessages.some((m) => m.includes('unbound')));
    });

    it('blocks createDomain when domain allowance is exhausted', async () => {
      const handlers = new Map<string, (...args: any[]) => any>();
      (vscode.commands as any).registerCommand = (cmd: string, fn: (...args: any[]) => any) => {
        handlers.set(cmd, fn);
        return { dispose() {} };
      };

      let createCalled = false;
      const mockBridge: any = {
        listDomainsWithAllowance: async () => ({
          domains: [{ id: 'd.boxliteapp.com', domain: 'd.boxliteapp.com', status: 'unbound' }],
          allowance: { limit: 1, used: 1, remaining: 0, minLength: 5, domainSuffix: 'boxliteapp.com' }
        }),
        createDomain: async () => {
          createCalled = true;
          return {};
        }
      };

      const warnings: string[] = [];
      (vscode.window as any).showWarningMessage = async (msg: string) => {
        warnings.push(msg);
        return undefined;
      };

      registerCommands(
        { subscriptions: [] } as any,
        mockBridge,
        { getApiKey: async () => 'blk_live_test' } as any,
        {} as any,
        { refresh() {} } as any,
        {} as any,
        {} as any
      );

      await handlers.get('boxlite.createDomain')!();
      assert.strictEqual(createCalled, false);
      assert.ok(warnings.some((w) => w.includes('Domain allowance full')));
    });
  });
});
