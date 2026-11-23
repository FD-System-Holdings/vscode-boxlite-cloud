import * as assert from 'assert';
import { BoxTreeItem, AccountTreeItem } from '../src/tree/nodes';
import { BoxesTreeDataProvider } from '../src/tree/boxesProvider';

describe('Box Tree Items and Lifecycle Management', () => {
  it('should normalize uppercase RUNNING and provide canStop context value', () => {
    const item = new BoxTreeItem({
      id: 'box-12345678',
      name: 'my-app',
      status: 'RUNNING' as any
    });
    assert.strictEqual(item.contextValue?.includes('canStop'), true);
    assert.strictEqual(item.contextValue?.includes('isRunning'), true);
    assert.strictEqual(item.contextValue?.includes('canStart'), false);
    assert.strictEqual(item.contextValue?.includes('isStopped'), false);
  });

  it('should normalize STOPPED and provide canStart context value', () => {
    const item = new BoxTreeItem({
      id: 'box-12345678',
      name: 'my-app',
      status: 'STOPPED' as any
    });
    assert.strictEqual(item.contextValue?.includes('canStart'), true);
    assert.strictEqual(item.contextValue?.includes('isStopped'), true);
    assert.strictEqual(item.contextValue?.includes('canStop'), false);
    assert.strictEqual(item.contextValue?.includes('isRunning'), false);
  });

  it('should treat CONFIGURED status as stopped and provide canStart context value', () => {
    const item = new BoxTreeItem({
      id: 'box-12345678',
      name: 'configured-app',
      status: 'configured' as any
    });
    assert.strictEqual(item.contextValue?.includes('canStart'), true);
    assert.strictEqual(item.contextValue?.includes('isStopped'), true);
    assert.strictEqual(item.contextValue?.includes('canStop'), false);
    assert.strictEqual(item.contextValue?.includes('isRunning'), false);
  });

  it('should not allow stopping an already STOPPING box and present transient child action', async () => {
    const item = new BoxTreeItem({
      id: 'box-12345678',
      name: 'stopping-app',
      status: 'stopping' as any
    });
    assert.strictEqual(item.contextValue?.includes('canStop'), false);
    assert.strictEqual(item.contextValue?.includes('isRunning'), false);
    assert.strictEqual(item.contextValue?.includes('canStart'), false);

    const provider = new BoxesTreeDataProvider({} as any, {} as any);
    const children = await provider.getChildren(item);
    assert.strictEqual(children.some((c) => c.label === 'Stop Box'), false);
    assert.strictEqual(children.some((c) => c.label === 'Stopping Box...'), true);
  });

  it('should expose Stop Box action child node for running boxes', async () => {
    const provider = new BoxesTreeDataProvider({} as any, {} as any);
    const boxItem = new BoxTreeItem({
      id: 'box-abcdef01',
      name: 'web-srv',
      status: 'running'
    });

    const children = await provider.getChildren(boxItem);
    const stopNode = children.find((c) => c.label === 'Stop Box');
    assert.ok(stopNode, 'Expected "Stop Box" child node for running box');
    assert.strictEqual(stopNode.command?.command, 'boxlite.stopBox');
  });

  it('should expose Start Box action child node for stopped boxes', async () => {
    const provider = new BoxesTreeDataProvider({} as any, {} as any);
    const boxItem = new BoxTreeItem({
      id: 'box-abcdef02',
      name: 'web-srv-2',
      status: 'stopped'
    });

    const children = await provider.getChildren(boxItem);
    const startNode = children.find((c) => c.label === 'Start Box');
    assert.ok(startNode, 'Expected "Start Box" child node for stopped box');
    assert.strictEqual(startNode.command?.command, 'boxlite.startBox');
  });

  it('should place SSH Console right under Start Box / Stop Box in tree children', async () => {
    const provider = new BoxesTreeDataProvider({} as any, {} as any);
    const stoppedBox = new BoxTreeItem({
      id: 'box-stopped-ssh',
      name: 'stopped-box',
      status: 'stopped',
      image: 'python'
    });
    const runningBox = new BoxTreeItem({
      id: 'box-running-ssh',
      name: 'running-box',
      status: 'running',
      image: 'python'
    });

    const stoppedChildren = await provider.getChildren(stoppedBox);
    assert.strictEqual(stoppedChildren[0]?.label, 'Start Box');
    assert.strictEqual(stoppedChildren[1]?.label, 'SSH Console');
    assert.strictEqual(stoppedChildren[1]?.command?.command, 'boxlite.sshConnect');

    const runningChildren = await provider.getChildren(runningBox);
    assert.strictEqual(runningChildren[0]?.label, 'Stop Box');
    assert.strictEqual(runningChildren[1]?.label, 'SSH Console');
    assert.strictEqual(runningChildren[1]?.command?.command, 'boxlite.sshConnect');
  });

  it('should contribute SSH Console context menu item right under Start Box in package.json', () => {
    const pkg = require('../../package.json');
    const commands: Array<{ command: string; title: string }> = pkg.contributes?.commands || [];
    const sshConsoleCmd = commands.find((c) => c.command === 'boxlite.sshConsole');
    assert.ok(sshConsoleCmd, 'Expected boxlite.sshConsole command in package.json');
    assert.strictEqual(sshConsoleCmd.title, 'SSH Console');

    const contextMenus: Array<{ command: string; when?: string; group?: string }> =
      pkg.contributes?.menus?.['view/item/context'] || [];
    const startEntry = contextMenus.find((m) => m.command === 'boxlite.startBox' && m.group?.startsWith('1_manage@'));
    const sshConsoleEntry = contextMenus.find((m) => m.command === 'boxlite.sshConsole');
    assert.ok(startEntry, 'Expected boxlite.startBox in 1_manage group');
    assert.ok(sshConsoleEntry, 'Expected boxlite.sshConsole in view/item/context');
    assert.strictEqual(sshConsoleEntry.group, '1_manage@4');
    assert.ok(sshConsoleEntry.when?.includes('view == boxlite.boxesView'));
    assert.ok(sshConsoleEntry.when?.includes('viewItem =~ /^box-.*/'));
  });

  it('should toggle Stop Streaming Logs when streaming is active', async () => {
    const mockLogManager: any = {
      isStreaming: (id: string) => id === 'box-active-log'
    };
    const provider = new BoxesTreeDataProvider({} as any, {} as any, mockLogManager);

    const activeItem = new BoxTreeItem({
      id: 'box-active-log',
      name: 'active',
      status: 'running'
    });
    const inactiveItem = new BoxTreeItem({
      id: 'box-inactive-log',
      name: 'inactive',
      status: 'running'
    });

    const activeChildren = await provider.getChildren(activeItem);
    assert.ok(activeChildren.some((c) => c.label === 'Stop Streaming Logs'));

    const inactiveChildren = await provider.getChildren(inactiveItem);
    assert.ok(inactiveChildren.some((c) => c.label === 'Application Logs'));
  });

  it('should format description with normalized status and ID prefix', () => {
    const item = new BoxTreeItem({
      id: '01HJK4TNRPQSXYZ8WM6NCVT9R5',
      name: 'prod-box',
      status: 'running',
      image: 'python:3.11'
    });
    assert.strictEqual(item.description, 'running · 01HJK4TN');
    assert.strictEqual(String(item.tooltip).includes('Status: running'), true);
  });

  it('should fallback to unknown when status is missing or empty', () => {
    const item = new BoxTreeItem({
      id: '01HJK4TNRPQSXYZ8WM6NCVT9R5',
      name: 'empty-box',
      status: ''
    });
    assert.strictEqual(item.description, 'unknown · 01HJK4TN');
    assert.strictEqual(String(item.tooltip).includes('Status: unknown'), true);
    assert.strictEqual(item.contextValue?.includes('box-unknown'), true);
  });

  it('should configure AccountTreeItem with account-signed-in context when authenticated', () => {
    const signedInItem = new AccountTreeItem('https://api.boxlite.ai', 'test-api-key');
    assert.strictEqual(signedInItem.contextValue, 'account-signed-in');
    assert.strictEqual(signedInItem.label, 'BoxLite Cloud Account');

    const signedOutItem = new AccountTreeItem('https://api.boxlite.ai', undefined);
    assert.strictEqual(signedOutItem.contextValue, 'account-signed-out');
  });

  it('should contribute context menu commands for account-signed-in in package.json', () => {
    const pkg = require('../../package.json');
    const contextMenus = pkg.contributes?.menus?.['view/item/context'] || [];
    const accountMenus = contextMenus.filter(
      (m: any) => m.when && m.when.includes("viewItem == 'account-signed-in'")
    );

    const commands = accountMenus.map((m: any) => m.command);
    assert.ok(commands.includes('boxlite.createBox'), 'Expected createBox in account context menu');
    assert.ok(commands.includes('boxlite.createBoxWithOptions'), 'Expected createBoxWithOptions in account context menu');
    assert.ok(commands.includes('boxlite.addImage'), 'Expected addImage in account context menu');
    assert.ok(commands.includes('boxlite.createVolume'), 'Expected createVolume in account context menu');
    assert.ok(commands.includes('boxlite.signOut'), 'Expected signOut in account context menu');
  });

  it('should stop log streaming immediately before stopping box', async () => {
    const vscode = require('vscode');
    const { registerCommands } = require('../src/commands');

    const executionOrder: string[] = [];
    const mockBridge: any = {
      stopBox: async (_id: string) => {
        executionOrder.push('bridge.stopBox');
        return { boxId: _id, status: 'stopped' };
      }
    };
    const mockLogManager: any = {
      stopStreaming: (_id: string) => {
        executionOrder.push('logManager.stopStreaming');
      }
    };
    const mockTreeProvider: any = {
      refresh: () => {}
    };

    const subscriptions: any[] = [];
    registerCommands(
      { subscriptions } as any,
      mockBridge,
      {} as any,
      {} as any,
      mockTreeProvider,
      {} as any,
      mockLogManager
    );

    const boxItem = new BoxTreeItem({
      id: 'box-test-order',
      name: 'test-box',
      status: 'running'
    });

    await vscode.commands.executeCommand('boxlite.stopBox', boxItem);
    assert.deepStrictEqual(executionOrder, ['logManager.stopStreaming', 'bridge.stopBox']);
  });

  it('should show friendly empty state when no boxes exist', async () => {
    const mockBridge: any = {
      listBoxes: async () => []
    };
    const mockCredentials: any = {
      getApiKey: async () => 'test-key',
      getRestUrl: () => 'https://api.boxlite.ai'
    };

    const provider = new BoxesTreeDataProvider(mockBridge, mockCredentials);
    const rootItems = await provider.getChildren();

    assert.strictEqual(rootItems.length, 1); // Empty State Item
    const emptyItem = rootItems[0];
    assert.strictEqual(emptyItem.label, 'No Managed Boxes');
    assert.strictEqual(emptyItem.description, 'Click to create a microvm box');
    assert.strictEqual(emptyItem.command?.command, 'boxlite.createBox');
  });

  it('should surface actionable no-NIC error and Create Box with Options action when configureOutbound or setAccess hits box networking is disabled', async () => {
    const vscode = require('vscode');
    const { registerCommands } = require('../src/commands');

    const origShowQuickPick = vscode.window.showQuickPick;
    const origShowErrorMessage = vscode.window.showErrorMessage;
    const origExecuteCommand = vscode.commands.executeCommand;

    const shownErrors: Array<{ msg: string; buttons: string[] }> = [];
    const executedCmds: string[] = [];

    try {
      const mockBridge: any = {
        updateOutbound: async () => {
          throw new Error(
            'BoxLite error [RuntimeError]: BoxLite Cloud API error (400): unsupported: box networking is disabled\nDiagnosis: Box networking is permanently disabled'
          );
        },
        updateInbound: async () => {
          throw new Error(
            'BoxLite error [RuntimeError]: BoxLite Cloud API error (400): unsupported: box networking is disabled\nDiagnosis: Box networking is permanently disabled'
          );
        }
      };

      registerCommands(
        { subscriptions: [] } as any,
        mockBridge,
        {} as any,
        {} as any,
        { refresh: () => {} } as any,
        {} as any,
        {} as any
      );

      vscode.window.showErrorMessage = async (msg: string, ...buttons: string[]) => {
        shownErrors.push({ msg, buttons });
        return buttons.includes('Create Box with Options...') ? 'Create Box with Options...' : undefined;
      };
      vscode.commands.executeCommand = async (id: string, ...args: any[]) => {
        executedCmds.push(id);
        if (id !== 'boxlite.createBoxWithOptions') {
          return origExecuteCommand(id, ...args);
        }
      };

      const boxItem = new BoxTreeItem({
        id: 'box-no-nic-1234',
        name: 'quick-box',
        status: 'running'
      });

      vscode.window.showQuickPick = async (items: any[]) =>
        items.find((i: any) => i.label.startsWith('Enabled (Unrestricted)'));
      await origExecuteCommand('boxlite.configureOutbound', boxItem);

      vscode.window.showQuickPick = async (items: any[]) =>
        items.find((i: any) => i.label.startsWith('Public'));
      await origExecuteCommand('boxlite.setAccess', boxItem);

      assert.strictEqual(shownErrors.length, 2);
      assert.ok(shownErrors[0].msg.includes('Cannot update outbound network'));
      assert.ok(shownErrors[0].msg.includes('no guest NIC provisioned at creation'));
      assert.ok(!shownErrors[0].msg.includes('auto_remove'));
      assert.ok(shownErrors[0].buttons.includes('Create Box with Options...'));

      assert.ok(shownErrors[1].msg.includes('Cannot update inbound access'));
      assert.ok(shownErrors[1].buttons.includes('Create Box with Options...'));
      assert.deepStrictEqual(executedCmds, ['boxlite.createBoxWithOptions', 'boxlite.createBoxWithOptions']);
    } finally {
      vscode.window.showQuickPick = origShowQuickPick;
      vscode.window.showErrorMessage = origShowErrorMessage;
      vscode.commands.executeCommand = origExecuteCommand;
    }
  });
});
