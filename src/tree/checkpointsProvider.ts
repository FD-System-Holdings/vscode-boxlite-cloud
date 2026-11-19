import * as vscode from 'vscode';
import { BoxLiteBridgeClient } from '../bridge/client';
import { CredentialsManager } from '../auth/credentials';
import {
  BoxLiteTreeItem,
  CheckpointTreeItem,
  CheckpointChildTreeItem,
  formatBytes,
  createErrorTreeItem
} from './nodes';

export class CheckpointsTreeDataProvider implements vscode.TreeDataProvider<BoxLiteTreeItem>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<BoxLiteTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private startupReady = true;
  private refreshTimer?: NodeJS.Timeout;
  private disposed = false;

  constructor(
    private bridge: BoxLiteBridgeClient,
    private credentials: CredentialsManager
  ) {}

  public setStartupReady(ready: boolean): void {
    this.startupReady = ready;
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  public refresh(): void {
    this.clearRefreshTimer();
    if (!this.disposed) {
      this._onDidChangeTreeData.fire();
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.clearRefreshTimer();
    this._onDidChangeTreeData.dispose();
  }

  public getTreeItem(element: BoxLiteTreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: BoxLiteTreeItem): Promise<BoxLiteTreeItem[]> {
    if (!this.startupReady) {
      return [];
    }

    if (!element) {
      const items: BoxLiteTreeItem[] = [];
      const apiKey = await this.credentials.getApiKey();

      if (!apiKey) {
        items.push(
          new CheckpointChildTreeItem(
            'Sign in to BoxLite Cloud',
            'Use the account section above to sign in',
            'sign-in',
            { command: 'boxlite.setApiKey', title: 'Sign In / Set API Key' }
          )
        );
        return items;
      }

      try {
        const checkpoints = await this.bridge.listCheckpoints();
        if (checkpoints.length === 0) {
          items.push(
            new CheckpointChildTreeItem(
              'No Managed Checkpoints',
              'Click to save a stopped Box as a checkpoint',
              'add',
              { command: 'boxlite.createCheckpoint', title: 'Create Checkpoint...' }
            )
          );
        } else {
          items.push(...checkpoints.map((c) => new CheckpointTreeItem(c)));

          // Auto-refresh if any checkpoint is in a transient state
          const hasTransient = checkpoints.some((c) => {
            const s = (c.state || '').toLowerCase().trim();
            return s === 'creating' || s === 'pending_create' || s === 'deleting' || s === 'pending_delete';
          });
          if (hasTransient && !this.disposed) {
            this.clearRefreshTimer();
            this.refreshTimer = setTimeout(() => {
              this.refreshTimer = undefined;
              this.refresh();
            }, 1500);
          }
        }
      } catch (err: any) {
        items.push(
          createErrorTreeItem({
            label: 'Error loading checkpoints',
            rawMessage: err.message || '',
            retryCommand: 'boxlite.refreshCheckpoints',
            contextPrefix: 'checkpoint',
            forbiddenDescription: '403 Forbidden · Insufficient permissions for checkpoints',
            forbiddenTooltip: `BoxLite Cloud API Error (403): Forbidden resource.\n\nEnsure your API key has permission to manage boxes and checkpoints (docs.boxlite.ai/cloud/checkpoints). Click to retry.`,
            createItem: (...args) => new CheckpointChildTreeItem(...args)
          })
        );
      }

      return items;
    }

    if (element instanceof CheckpointTreeItem) {
      const chk = element.checkpoint;
      const children: BoxLiteTreeItem[] = [];
      const key = chk.id;

      // 1. Checkpoint ID
      children.push(
        new CheckpointChildTreeItem(
          'Checkpoint ID',
          chk.id,
          'key',
          {
            command: 'boxlite.copyCheckpointId',
            title: 'Copy Checkpoint ID',
            arguments: [element]
          },
          vscode.TreeItemCollapsibleState.None,
          'checkpoint-id-item',
          key
        )
      );

      // 2. State
      const state = (chk.state || 'ready').toLowerCase().trim();
      const stateDesc = state === 'failed' && chk.errorReason ? `${state} · ${chk.errorReason}` : state;
      children.push(
        new CheckpointChildTreeItem(
          'State',
          stateDesc,
          state === 'ready' ? 'check' : (state === 'failed' || state === 'error' ? 'error' : 'sync~spin'),
          undefined,
          vscode.TreeItemCollapsibleState.None,
          'checkpoint-state-item',
          key,
          chk.errorReason ? `State: ${state}\nError: ${chk.errorReason}` : `State: ${state}`
        )
      );

      // 3. Source Box
      if (chk.sourceBoxId) {
        children.push(
          new CheckpointChildTreeItem(
            'Source Box',
            chk.sourceBoxId,
            'vm',
            {
              command: 'boxlite.inspectBox',
              title: 'Inspect Source Box',
              arguments: [chk.sourceBoxId]
            },
            vscode.TreeItemCollapsibleState.None,
            'checkpoint-source-item',
            key
          )
        );
      }

      // 4. Size
      if (chk.sizeBytes && chk.sizeBytes > 0) {
        children.push(
          new CheckpointChildTreeItem(
            'Size',
            formatBytes(chk.sizeBytes),
            'file-binary',
            undefined,
            vscode.TreeItemCollapsibleState.None,
            'checkpoint-size-item',
            key
          )
        );
      }

      // 5. Created At
      if (chk.createdAt) {
        children.push(
          new CheckpointChildTreeItem(
            'Created At',
            chk.createdAt,
            'calendar',
            undefined,
            vscode.TreeItemCollapsibleState.None,
            'checkpoint-created-item',
            key
          )
        );
      }

      // 6. Create Box from Checkpoint
      children.push(
        new CheckpointChildTreeItem(
          'Create Box from Checkpoint...',
          'Launch an independent box inheriting saved disk & config',
          'repo-forked',
          {
            command: 'boxlite.createBoxFromCheckpoint',
            title: 'Create Box from Checkpoint...',
            arguments: [element]
          },
          vscode.TreeItemCollapsibleState.None,
          'checkpoint-create-box-action',
          key
        )
      );

      // 7. Fork Worker Fleet
      children.push(
        new CheckpointChildTreeItem(
          'Fork Worker Fleet...',
          'Spawn multiple independent worker boxes in parallel',
          'organization',
          {
            command: 'boxlite.forkFleetFromCheckpoint',
            title: 'Fork Worker Fleet...',
            arguments: [element]
          },
          vscode.TreeItemCollapsibleState.None,
          'checkpoint-fork-fleet-action',
          key
        )
      );

      // 8. Inspect Checkpoint Details
      children.push(
        new CheckpointChildTreeItem(
          'Inspect Checkpoint Details',
          'View JSON specification',
          'json',
          {
            command: 'boxlite.inspectCheckpoint',
            title: 'Inspect Checkpoint Details',
            arguments: [element]
          },
          vscode.TreeItemCollapsibleState.None,
          'checkpoint-inspect-action',
          key
        )
      );

      // 9. Delete Checkpoint
      children.push(
        new CheckpointChildTreeItem(
          'Delete Checkpoint',
          'Permanently remove checkpoint archive',
          'trash',
          {
            command: 'boxlite.deleteCheckpoint',
            title: 'Delete Checkpoint',
            arguments: [element]
          },
          vscode.TreeItemCollapsibleState.None,
          'checkpoint-delete-action',
          key
        )
      );

      return children;
    }

    return [];
  }
}
