const Module = require('module');
const originalRequire = Module.prototype.require;

const commandRegistry = new Map();

const mockVscode = {
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({
      get: (_key, def) => def,
      update: async () => {}
    }),
    openTextDocument: async () => ({}),
  },
  window: {
    terminals: [],
    onDidCloseTerminal: () => ({ dispose: () => {} }),
    createTerminal: (options) => {
      const term = {
        name: options?.name || 'Terminal',
        creationOptions: options,
        sentTexts: [],
        shown: false,
        disposed: false,
        show: () => {
          term.shown = true;
        },
        sendText: (text) => {
          term.sentTexts.push(text);
        },
        dispose: () => {
          term.disposed = true;
        }
      };
      mockVscode.window.terminals.push(term);
      return term;
    },
    showInformationMessage: async () => {},
    showErrorMessage: async () => {},
    showWarningMessage: async () => {},
    createOutputChannel: () => ({
      append: () => {},
      appendLine: () => {},
      replace: () => {},
      clear: () => {},
      show: () => {},
      hide: () => {},
      dispose: () => {}
    }),
    showInputBox: async () => undefined,
    showQuickPick: async () => undefined,
    withProgress: async (_options, task) => {
      return await task({ report: () => {} });
    }
  },
  env: {
    clipboard: {
      writeText: async () => {}
    },
    openExternal: async () => true
  },
  extensions: {
    getExtension: () => undefined
  },
  ConfigurationTarget: {
    Global: 1,
    Workspace: 2,
    WorkspaceFolder: 3
  },
  ProgressLocation: {
    Notification: 15,
    Window: 10,
    SourceControl: 1
  },
  commands: {
    registerCommand: (id, callback) => {
      commandRegistry.set(id, callback);
      return { dispose: () => commandRegistry.delete(id) };
    },
    executeCommand: async (id, ...args) => {
      const handler = commandRegistry.get(id);
      if (handler) {
        return await handler(...args);
      }
    }
  },
  Uri: {
    file: (p) => ({ fsPath: p, scheme: 'file' }),
    parse: (u) => ({ toString: () => u })
  },
  TreeItem: class {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: {
    None: 0,
    Collapsed: 1,
    Expanded: 2
  },
  ThemeIcon: class {
    constructor(id, color) {
      this.id = id;
      this.color = color;
    }
  },
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },
  EventEmitter: class {
    constructor() {
      this.event = (listener) => {
        this.listener = listener;
      };
    }
    fire(data) {
      if (this.listener) this.listener(data);
    }
  },
  Disposable: class {
    dispose() {}
  }
};

Module.prototype.require = function (id) {
  if (id === 'vscode') {
    return mockVscode;
  }
  return originalRequire.apply(this, arguments);
};
