import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import {
  ImageTreeItem,
  ImageUsageTreeItem,
  ImageGroupTreeItem,
  ImageChildTreeItem,
  formatBytes
} from '../src/tree/nodes';
import {
  ImagesTreeDataProvider,
  buildImageList,
  BUILTIN_IMAGES
} from '../src/tree/imagesProvider';
import { BoxesTreeDataProvider } from '../src/tree/boxesProvider';
import { BoxLiteBridgeClient } from '../src/bridge/client';
import { BoxListItem, ImageItem } from '../src/bridge/protocol';
import {
  ImagePullFailureError,
  launchBoxFromOwnImage,
  pollCatalogForImage,
  runUseYourOwnImageFlow
} from '../src/images/customImageWorkflow';
import { registerCommands } from '../src/commands';

describe('Images List Building and Sorting', () => {
  it('should include 4 built-in images and flag default image', () => {
    const result = buildImageList([], BUILTIN_IMAGES, [], [], 'python');

    assert.strictEqual(result.builtins.length, 4);
    assert.deepStrictEqual(
      result.builtins.map((b) => b.name),
      ['base', 'python', 'node', 'sandbaseai-hermes']
    );

    const pythonImg = result.builtins.find((b) => b.name === 'python');
    assert.ok(pythonImg);
    assert.strictEqual(pythonImg?.builtin, true);
    assert.strictEqual(pythonImg?.isDefault, true);

    const nodeImg = result.builtins.find((b) => b.name === 'node');
    assert.strictEqual(nodeImg?.builtin, true);
    assert.strictEqual(nodeImg?.isDefault, false);
  });

  it('should map active box counts and box references to images', () => {
    const activeBoxes: BoxListItem[] = [
      { id: 'box_001', name: 'web-prod', status: 'running', image: 'python' },
      { id: 'box_002', name: 'worker-1', status: 'stopped', image: 'python' },
      { id: 'box_003', name: 'node-api', status: 'running', image: 'node' },
      { id: 'box_004', name: 'custom-alpine', status: 'running', image: 'docker.io/library/alpine:3.20' }
    ];

    const catalogImages: ImageItem[] = [
      { name: 'docker.io/library/alpine:3.20', sizeBytes: 3630321 }
    ];

    const result = buildImageList(catalogImages, BUILTIN_IMAGES, [], activeBoxes, 'python');

    const pythonImg = result.builtins.find((b) => b.name === 'python');
    assert.strictEqual(pythonImg?.boxCount, 2);
    assert.strictEqual(pythonImg?.boxes?.length, 2);

    const nodeImg = result.builtins.find((b) => b.name === 'node');
    assert.strictEqual(nodeImg?.boxCount, 1);

    const baseImg = result.builtins.find((b) => b.name === 'base');
    assert.strictEqual(baseImg?.boxCount, 0);

    const alpineImg = result.catalog.find((c) => c.name === 'docker.io/library/alpine:3.20');
    assert.ok(alpineImg);
    assert.strictEqual(alpineImg?.boxCount, 1);
    assert.strictEqual(alpineImg?.builtin, false);
    assert.strictEqual(alpineImg?.recorded, true);
  });

  it('should surface unrecorded custom images from settings', () => {
    const customNames = ['ghcr.io/acme/private-api:latest', 'docker.io/library/ubuntu:24.04'];
    const result = buildImageList([], BUILTIN_IMAGES, customNames, [], 'python');

    assert.strictEqual(result.customOnly.length, 2);
    const customImg = result.customOnly.find((c) => c.name === 'ghcr.io/acme/private-api:latest');
    assert.ok(customImg);
    assert.strictEqual(customImg?.recorded, false);
    assert.strictEqual(customImg?.builtin, false);
  });

  it('should sort catalog items with default first, in-use next, then alphabetical', () => {
    const catalog: ImageItem[] = [
      { name: 'docker.io/library/redis:alpine' },
      { name: 'docker.io/library/alpine:3.20' },
      { name: 'ghcr.io/acme/api:1.4.0' }
    ];

    const activeBoxes: BoxListItem[] = [
      { id: 'b1', name: 'redis-box', status: 'running', image: 'docker.io/library/redis:alpine' }
    ];

    // Set ghcr.io/acme/api:1.4.0 as default image
    const result = buildImageList(catalog, BUILTIN_IMAGES, [], activeBoxes, 'ghcr.io/acme/api:1.4.0');

    // Expected order:
    // 1. ghcr.io/acme/api:1.4.0 (default)
    // 2. docker.io/library/redis:alpine (in-use: 1 box)
    // 3. docker.io/library/alpine:3.20 (unused, alphabetical)
    assert.strictEqual(result.catalog[0].name, 'ghcr.io/acme/api:1.4.0');
    assert.strictEqual(result.catalog[1].name, 'docker.io/library/redis:alpine');
    assert.strictEqual(result.catalog[2].name, 'docker.io/library/alpine:3.20');
  });

  it('should surface in-use images from boxes not present in catalog as recorded catalog images', () => {
    const activeBoxes: BoxListItem[] = [
      { id: 'b1', name: 'app', status: 'running', image: 'quay.io/coreos/etcd:v3.5.0' }
    ];

    const result = buildImageList([], BUILTIN_IMAGES, [], activeBoxes, 'python');
    const etcd = result.catalog.find((c) => c.name === 'quay.io/coreos/etcd:v3.5.0');
    assert.ok(etcd);
    assert.strictEqual(etcd?.boxCount, 1);
    assert.strictEqual(etcd?.recorded, true);
  });

  it('should handle catalog items missing name and non-string customImageNames without throwing', () => {
    const malformedCatalog: any[] = [
      { repository: 'docker.io/library/alpine', tag: '3.20', size_bytes: 3630321 },
      { image_name: 'ghcr.io/acme/worker' },
      { name: undefined },
      null
    ];
    const malformedCustom: any[] = [null, undefined, 123, 'ghcr.io/acme/custom:1.0'];

    const result = buildImageList(malformedCatalog, BUILTIN_IMAGES, malformedCustom, [], 'python');

    const alpine = result.catalog.find((c) => c.name === 'docker.io/library/alpine:3.20');
    assert.ok(alpine);
    assert.strictEqual(alpine?.sizeBytes, 3630321);

    const worker = result.catalog.find((c) => c.name === 'ghcr.io/acme/worker');
    assert.ok(worker);

    assert.strictEqual(result.catalog.length, 2);
    assert.strictEqual(result.customOnly.length, 1);
    assert.strictEqual(result.customOnly[0].name, 'ghcr.io/acme/custom:1.0');
  });
});

describe('Image Tree Item Presentation & Node Formatting', () => {
  it('should format ImageUsageTreeItem correctly with byte sizing and limits', () => {
    const item = new ImageUsageTreeItem({
      count: 2,
      limit: 20,
      knownBytes: 3630321
    });

    assert.strictEqual(item.label, '2 of 20 images · 3.5 MiB');
    assert.strictEqual(item.description, undefined);
    assert.strictEqual(item.contextValue, 'image-usage-item');
    assert.ok(String(item.tooltip || '').includes('Limit: 20 per organization'));
  });

  it('should warn on near-limit and limit-reached in ImageUsageTreeItem', () => {
    const nearLimitItem = new ImageUsageTreeItem({ count: 18, limit: 20, knownBytes: 1000000 });
    assert.strictEqual(nearLimitItem.description, 'Near limit');

    const limitReachedItem = new ImageUsageTreeItem({ count: 20, limit: 20, knownBytes: 5000000 });
    assert.strictEqual(limitReachedItem.description, 'Limit reached');
  });

  it('should format built-in and default ImageTreeItem with appropriate icons and context values', () => {
    const defaultPython = new ImageTreeItem({
      name: 'python',
      builtin: true,
      isDefault: true,
      boxCount: 3
    });

    assert.strictEqual(defaultPython.label, 'python');
    assert.strictEqual(defaultPython.description, '★ default · free · 3 boxes');
    assert.ok(defaultPython.contextValue?.includes('image-builtin'));
    assert.ok(defaultPython.contextValue?.includes('image-default'));
    assert.ok(defaultPython.contextValue?.includes('image-in-use'));

    const customUnbooted = new ImageTreeItem({
      name: 'docker.io/library/alpine:3.20',
      builtin: false,
      recorded: false,
      isDefault: false
    });

    assert.strictEqual(customUnbooted.label, 'docker.io/library/alpine:3.20');
    assert.strictEqual(customUnbooted.description, 'saved (not booted)');
    assert.ok(customUnbooted.contextValue?.includes('image-custom'));
    assert.ok(customUnbooted.contextValue?.includes('image-unrecorded'));
  });

  it('should format formatBytes helper accurately across scales', () => {
    assert.strictEqual(formatBytes(0), '0 B');
    assert.strictEqual(formatBytes(512), '512 B');
    assert.strictEqual(formatBytes(1024), '1 KiB');
    assert.strictEqual(formatBytes(1536), '1.5 KiB');
    assert.strictEqual(formatBytes(1048576), '1 MiB');
    assert.strictEqual(formatBytes(3630321), '3.5 MiB');
    assert.strictEqual(formatBytes(1073741824), '1 GiB');
  });
});

describe('ImagesTreeDataProvider Tree Hierarchy & Lifecycle', () => {
  it('should return ONLY the sign-in prompt when signed out', async () => {
    const mockBridge: any = {
      listImages: async () => ({ images: [] }),
      listBoxes: async () => []
    };
    const mockCredentials: any = {
      getApiKey: async () => undefined,
      getRestUrl: () => 'https://api.boxlite.ai'
    };

    const provider = new ImagesTreeDataProvider(mockBridge, mockCredentials);
    const items = await provider.getChildren();

    assert.strictEqual(items.length, 1);
    const signinNode = items[0] as ImageChildTreeItem;
    assert.strictEqual(signinNode.label, 'Sign in to BoxLite Cloud');
    assert.strictEqual(signinNode.command?.command, 'boxlite.setApiKey');
  });

  it('should return Usage, Built-in Group, and Images when signed in', async () => {
    const mockBridge: any = {
      listImages: async () => ({
        images: [{ name: 'docker.io/library/alpine:3.20', sizeBytes: 3630321 }],
        usage: { count: 1, limit: 20, knownBytes: 3630321 }
      }),
      listBoxes: async () => [
        { id: 'box_123', name: 'demo-app', status: 'running', image: 'python' }
      ]
    };
    const mockCredentials: any = {
      getApiKey: async () => 'test-api-key',
      getRestUrl: () => 'https://api.boxlite.ai'
    };

    const provider = new ImagesTreeDataProvider(mockBridge, mockCredentials);
    const rootItems = await provider.getChildren();

    assert.strictEqual(rootItems.length, 3);

    // 1. ImageUsageTreeItem
    assert.ok(rootItems[0] instanceof ImageUsageTreeItem);
    assert.strictEqual((rootItems[0] as ImageUsageTreeItem).label, '1 of 20 images · 3.5 MiB');

    // 2. ImageGroupTreeItem (Built-in)
    assert.ok(rootItems[1] instanceof ImageGroupTreeItem);
    assert.strictEqual((rootItems[1] as ImageGroupTreeItem).label, 'Built-in (free · not counted)');

    // 3. Catalog Image
    assert.ok(rootItems[2] instanceof ImageTreeItem);
    assert.strictEqual((rootItems[2] as ImageTreeItem).image.name, 'docker.io/library/alpine:3.20');
  });

  it('should provide the 4 built-in image nodes when expanding Built-in Group', async () => {
    const mockBridge: any = {
      listImages: async () => ({ images: [] }),
      listBoxes: async () => []
    };
    const mockCredentials: any = {
      getApiKey: async () => 'test-key',
      getRestUrl: () => 'https://api.boxlite.ai'
    };

    const provider = new ImagesTreeDataProvider(mockBridge, mockCredentials);
    const rootItems = await provider.getChildren();
    const groupNode = rootItems.find((i) => i instanceof ImageGroupTreeItem) as ImageGroupTreeItem;
    assert.ok(groupNode);

    const builtinChildren = await provider.getChildren(groupNode);
    assert.strictEqual(builtinChildren.length, 4);
    assert.deepStrictEqual(
      builtinChildren.map((c) => (c as ImageTreeItem).image.name),
      ['base', 'python', 'node', 'sandbaseai-hermes']
    );
  });

  it('should provide complete action hierarchy and box usage under an Image node', async () => {
    const imgItem = new ImageTreeItem({
      name: 'docker.io/library/alpine:3.20',
      builtin: false,
      recorded: true,
      lastUsedAt: '2026-11-10T20:00:00Z',
      sizeBytes: 3630321,
      boxes: [{ id: 'b_123', name: 'alpine-worker', status: 'running' }]
    });

    const provider = new ImagesTreeDataProvider({} as any, { getApiKey: async () => 'k' } as any);
    const children = await provider.getChildren(imgItem);

    // Box usage child
    const boxNode = children.find((c) => c.label === 'alpine-worker');
    assert.ok(boxNode, 'Expected active box child node');
    assert.strictEqual(boxNode?.command?.command, 'boxlite.inspectBox');

    // Create Box action
    const createNode = children.find((c) => c.label === 'Create Box from Image...');
    assert.ok(createNode);
    assert.strictEqual(createNode?.command?.command, 'boxlite.createBoxFromImage');

    // Set Default action
    const defaultNode = children.find((c) => c.label === 'Set as Default Image');
    assert.ok(defaultNode);
    assert.strictEqual(defaultNode?.command?.command, 'boxlite.setDefaultImage');

    // Inspect Details action
    const inspectNode = children.find((c) => c.label === 'Inspect Image Details');
    assert.ok(inspectNode);
    assert.strictEqual(inspectNode?.command?.command, 'boxlite.inspectImage');

    // Pin Alias action (custom only)
    const pinNode = children.find((c) => c.label === 'Pin Image Alias...');
    assert.ok(pinNode);
    assert.strictEqual(pinNode?.command?.command, 'boxlite.pinImageAlias');

    // Delete action (custom only)
    const deleteNode = children.find((c) => c.label === 'Delete Image');
    assert.ok(deleteNode);
    assert.strictEqual(deleteNode?.command?.command, 'boxlite.removeImage');
  });

  it('should present 403 forbidden resource with Full key diagnostic guidance', async () => {
    const mockBridge: any = {
      listImages: async () => {
        throw new Error('BoxLite Cloud API error (403): Forbidden resource\nDiagnosis: 403 Forbidden: For private images or registries, ensure API key has Full access (docs.boxlite.ai/cloud/private-images).');
      },
      listBoxes: async () => {
        throw new Error('403 Forbidden');
      }
    };
    const mockCredentials: any = {
      getApiKey: async () => 'test-key',
      getRestUrl: () => 'https://api.boxlite.ai'
    };

    const provider = new ImagesTreeDataProvider(mockBridge, mockCredentials);
    const rootItems = await provider.getChildren();

    assert.strictEqual(rootItems.length, 1);
    const errorItem = rootItems[0];
    assert.strictEqual(errorItem.label, 'Error loading images');
    assert.ok(String(errorItem.description).includes('403 Forbidden'));
    assert.ok(String(errorItem.description).includes('Full access key'));
  });

  it('should gracefully degrade when listImages fails without throwing exception', async () => {
    const mockBridge: any = {
      listImages: async () => {
        throw new Error('Route not found (/images)');
      },
      listBoxes: async () => [
        { id: 'b_1', name: 'py-app', status: 'running', image: 'python' }
      ]
    };
    const mockCredentials: any = {
      getApiKey: async () => 'test-key',
      getRestUrl: () => 'https://api.boxlite.ai'
    };

    const provider = new ImagesTreeDataProvider(mockBridge, mockCredentials);
    const rootItems = await provider.getChildren();

    // Must successfully return usage and built-ins derived from local state
    const usageNode = rootItems.find((i) => i instanceof ImageUsageTreeItem);
    assert.ok(usageNode);

    const builtinGroup = rootItems.find((i) => i instanceof ImageGroupTreeItem);
    assert.ok(builtinGroup);
  });

  it('should succeed when listImages returns items without name or with undefined names', async () => {
    const mockBridge: any = {
      listImages: async () => ({
        images: [
          { repository: 'docker.io/library/alpine', tag: '3.20', size_bytes: 3630321 },
          { name: undefined },
          { imageName: 'ghcr.io/acme/service:latest' }
        ]
      }),
      listBoxes: async () => []
    };
    const mockCredentials: any = {
      getApiKey: async () => 'test-key',
      getRestUrl: () => 'https://api.boxlite.ai'
    };

    const provider = new ImagesTreeDataProvider(mockBridge, mockCredentials);
    const rootItems = await provider.getChildren();

    const errorNode = rootItems.find((i) => i.label === 'Error loading images');
    assert.strictEqual(errorNode, undefined);

    const imageLabels = rootItems
      .filter((i): i is ImageTreeItem => i instanceof ImageTreeItem)
      .map((i) => i.image.name);
    assert.deepStrictEqual(imageLabels, [
      'docker.io/library/alpine:3.20',
      'ghcr.io/acme/service:latest'
    ]);
  });
});

describe('Package.json Images UI Contribution Specifications', () => {
  it('should place boxlite.imagesView strictly between boxlite.boxesView and boxlite.volumesView', () => {
    const pkgPath = path.resolve(__dirname, '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

    const views = pkg.contributes?.views?.['boxlite-explorer'] || [];
    const accountIndex = views.findIndex((v: any) => v.id === 'boxlite.accountView');
    const boxesIndex = views.findIndex((v: any) => v.id === 'boxlite.boxesView');
    const imagesIndex = views.findIndex((v: any) => v.id === 'boxlite.imagesView');
    const volumesIndex = views.findIndex((v: any) => v.id === 'boxlite.volumesView');

    assert.ok(accountIndex >= 0, 'Expected boxlite.accountView to exist');
    assert.ok(boxesIndex >= 0, 'Expected boxlite.boxesView to exist');
    assert.ok(imagesIndex >= 0, 'Expected boxlite.imagesView to exist');
    assert.ok(volumesIndex >= 0, 'Expected boxlite.volumesView to exist');

    assert.ok(accountIndex < boxesIndex, 'Expected boxlite.accountView to be placed above boxlite.boxesView');
    assert.ok(
      boxesIndex < imagesIndex && imagesIndex < volumesIndex,
      `Images view (index ${imagesIndex}) must be strictly between Boxes view (${boxesIndex}) and Volumes view (${volumesIndex})`
    );
  });

  it('should contribute all required image commands with icons and BoxLite category', () => {
    const pkgPath = path.resolve(__dirname, '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

    const requiredCommands = [
      'boxlite.refreshImages',
      'boxlite.addImage',
      'boxlite.createBoxFromImage',
      'boxlite.setDefaultImage',
      'boxlite.copyImageName',
      'boxlite.inspectImage',
      'boxlite.pinImageAlias',
      'boxlite.removeImage',
      'boxlite.addRegistryLogin'
    ];

    const commands = pkg.contributes?.commands || [];
    for (const cmdId of requiredCommands) {
      const match = commands.find((c: any) => c.command === cmdId);
      assert.ok(match, `Expected command "${cmdId}" to be contributed in package.json`);
      assert.strictEqual(match.category, 'BoxLite');
      assert.ok(match.icon, `Expected command "${cmdId}" to have an icon`);
    }
  });

  it('should contribute boxlite.customImages and updated boxlite.defaultImage configuration', () => {
    const pkgPath = path.resolve(__dirname, '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

    const props = pkg.contributes?.configuration?.properties || {};
    assert.ok(props['boxlite.customImages'], 'Expected boxlite.customImages configuration property');
    assert.strictEqual(props['boxlite.customImages'].type, 'array');

    assert.ok(props['boxlite.defaultImage'], 'Expected boxlite.defaultImage configuration property');
    assert.strictEqual(props['boxlite.defaultImage'].default, 'python');
  });
});

describe('Use Your Own Image Workflow (Zero-CLI Built-in API)', () => {
  const sampleDigest =
    'sha256:c64c687cbea90123456789abcdef0123456789abcdef0123456789abcdef0123';

  it('deduplicates digest-pinned box readbacks and saved custom refs against catalog records in buildImageList', () => {
    const catalogImages: ImageItem[] = [
      { name: 'docker.io/library/alpine', sizeBytes: 3630321 }
    ];
    const activeBoxes: BoxListItem[] = [
      {
        id: 'box_digest_1',
        name: 'demo',
        status: 'running',
        image: `docker.io/library/alpine@${sampleDigest}`
      }
    ];
    const savedCustom = ['docker.io/library/alpine:3.20', 'alpine'];

    const result = buildImageList(catalogImages, BUILTIN_IMAGES, savedCustom, activeBoxes, 'python');

    assert.strictEqual(result.catalog.length, 1);
    assert.strictEqual(result.catalog[0].name, 'docker.io/library/alpine');
    assert.strictEqual(result.catalog[0].boxCount, 1);
    assert.strictEqual(result.catalog[0].digest, sampleDigest);
    assert.strictEqual(result.customOnly.length, 0);
  });

  it('polls the image catalog until boot recording appears and captures box digest readback', async () => {
    let listCalls = 0;
    const mockBridge = {
      listImages: async () => {
        listCalls++;
        if (listCalls < 3) {
          return { images: [], usage: { count: 0, limit: 20, knownBytes: 0 } };
        }
        return {
          images: [{ name: 'docker.io/library/alpine', sizeBytes: 3630321 }],
          usage: { count: 1, limit: 20, knownBytes: 3630321 }
        };
      },
      inspectBox: async () => ({
        id: 'box_demo_1',
        image: `docker.io/library/alpine@${sampleDigest}`
      }),
      inspectImage: async () => ({
        name: 'docker.io/library/alpine',
        versions: [{ digest: sampleDigest, sizeBytes: 3630321 }],
        aliases: [],
        history: []
      })
    } as unknown as BoxLiteBridgeClient;

    const result = await pollCatalogForImage(mockBridge, 'docker.io/library/alpine:3.20', 'box_demo_1', {
      maxAttempts: 5,
      intervalMs: 0,
      sleep: async () => {}
    });

    assert.strictEqual(result.recorded, true);
    assert.strictEqual(result.attempts, 3);
    assert.strictEqual(result.catalogImage?.name, 'docker.io/library/alpine');
    assert.strictEqual(result.digest, sampleDigest);
    assert.strictEqual(result.resolvedBoxImage, `docker.io/library/alpine@${sampleDigest}`);
    assert.strictEqual(result.usage?.count, 1);
  });

  it('skips catalog polling for built-in images and honors cancellation/timeout', async () => {
    let listCalled = false;
    const builtinBridge = {
      listImages: async () => {
        listCalled = true;
        return { images: [] };
      },
      inspectBox: async () => ({ id: 'box_py', image: 'python' })
    } as unknown as BoxLiteBridgeClient;

    const builtinRes = await pollCatalogForImage(builtinBridge, 'python', 'box_py');
    assert.strictEqual(listCalled, false);
    assert.strictEqual(builtinRes.recorded, false);
    assert.strictEqual(builtinRes.attempts, 0);

    let cancelAttempts = 0;
    const cancelRes = await pollCatalogForImage(
      {
        listImages: async () => {
          cancelAttempts++;
          return { images: [] };
        },
        inspectBox: async () => ({ id: 'box_2', image: 'docker.io/library/alpine:3.20' })
      } as unknown as BoxLiteBridgeClient,
      'docker.io/library/alpine:3.20',
      'box_2',
      {
        maxAttempts: 5,
        intervalMs: 0,
        isCancelled: () => cancelAttempts >= 1
      }
    );
    assert.strictEqual(cancelRes.recorded, false);
    assert.strictEqual(cancelRes.attempts, 1);
  });

  it('cleans up leftover failed boxes by name on image pull failure, but not on 409/limit errors', async () => {
    const removedTargets: Array<{ target: string; opts: any }> = [];
    const pullErr = new Error(
      "Box state transition failed: Failed to pull image 'acme/api:1.4.0': docker.io refused the pull (UNAUTHORIZED)."
    );

    const failingPullBridge = {
      createBox: async () => {
        throw pullErr;
      },
      removeBox: async (target: string, opts: any) => {
        removedTargets.push({ target, opts });
        return { boxId: 'box_orphan', removed: true };
      }
    } as unknown as BoxLiteBridgeClient;

    await assert.rejects(
      () =>
        launchBoxFromOwnImage(failingPullBridge, {
          name: 'demo-orphan',
          image: 'acme/api:1.4.0'
        }),
      (err: any) => {
        assert.ok(err instanceof ImagePullFailureError);
        assert.strictEqual(err.boxName, 'demo-orphan');
        assert.strictEqual(err.cleanedUp, true);
        assert.strictEqual(err.diagnosis.summary, 'Image Pull Failed');
        return true;
      }
    );
    assert.strictEqual(removedTargets.length, 1);
    assert.strictEqual(removedTargets[0].target, 'demo-orphan');
    assert.strictEqual(removedTargets[0].opts?.ignoreNotFound, true);

    // 409 Conflict must NEVER delete an existing box
    const conflictRemovals: string[] = [];
    const conflictBridge = {
      createBox: async () => {
        throw new Error('409 Conflict: box name already exists');
      },
      removeBox: async (target: string) => {
        conflictRemovals.push(target);
        return { boxId: target, removed: true };
      }
    } as unknown as BoxLiteBridgeClient;

    await assert.rejects(
      () =>
        launchBoxFromOwnImage(conflictBridge, {
          name: 'existing-prod-box',
          image: 'docker.io/library/alpine:3.20'
        }),
      /409 Conflict/
    );
    assert.strictEqual(conflictRemovals.length, 0);
  });

  it('runs end-to-end Use Your Own Image flow (Docker Hub vs built-in warning, create, poll, and pin alias)', async () => {
    const vscode = require('vscode');
    const origGetConfiguration = vscode.workspace.getConfiguration;
    const origShowInputBox = vscode.window.showInputBox;
    const origShowQuickPick = vscode.window.showQuickPick;
    const origShowWarningMessage = vscode.window.showWarningMessage;
    const origShowInformationMessage = vscode.window.showInformationMessage;
    const origShowErrorMessage = vscode.window.showErrorMessage;

    const savedCustomImages: string[] = [];
    const createdBoxArgs: any[] = [];
    const createdAliases: any[] = [];
    const infoMessages: string[] = [];

    try {
      vscode.workspace.getConfiguration = () => ({
        get: (key: string, def: any) => (key === 'customImages' ? [...savedCustomImages] : def),
        update: async (key: string, val: any) => {
          if (key === 'customImages') {
            savedCustomImages.splice(0, savedCustomImages.length, ...val);
          }
        }
      });

      let inputStep = 0;
      vscode.window.showInputBox = async (opts: any) => {
        inputStep++;
        if (inputStep === 1) {
          // User types 'python', which triggers built-in shadowing warning
          return 'python';
        }
        if (inputStep === 2) {
          // Box name prompt
          return 'demo';
        }
        // Alias name prompt when Pin Alias... runs
        if (opts?.prompt?.includes('alias')) {
          return 'stable';
        }
        return undefined;
      };

      vscode.window.showWarningMessage = async (_msg: string, ...items: any[]) => {
        // Choose Docker Hub option instead of BoxLite built-in
        return items.find((i) => typeof i === 'string' && i.includes('Use Docker Hub'));
      };

      vscode.window.showQuickPick = async (items: any[]) => {
        const startItem = items.find((i) => i.action === 'create');
        if (startItem) {
          return startItem;
        }
        // In pinImageAlias digest picker, pick the first recorded digest
        return items.find((i) => typeof i.digest === 'string');
      };

      vscode.window.showInformationMessage = async (msg: string, ...buttons: string[]) => {
        infoMessages.push(msg);
        if (buttons.includes('Pin Alias...')) {
          return 'Pin Alias...';
        }
        return undefined;
      };
      vscode.window.showErrorMessage = async (msg: string) => {
        assert.fail(`Unexpected error message: ${msg}`);
      };

      const mockBridge: any = {
        createBox: async (args: any) => {
          createdBoxArgs.push(args);
          return {
            boxId: 'box_custom_1',
            name: args.name,
            status: 'running',
            image: `docker.io/library/python@${sampleDigest}`
          };
        },
        inspectBox: async () => ({
          id: 'box_custom_1',
          image: `docker.io/library/python@${sampleDigest}`
        }),
        listImages: async () => ({
          images: [{ name: 'docker.io/library/python', sizeBytes: 12345678 }],
          usage: { count: 1, limit: 20, knownBytes: 12345678 }
        }),
        inspectImage: async () => ({
          name: 'docker.io/library/python',
          versions: [{ digest: sampleDigest, sizeBytes: 12345678 }],
          aliases: [],
          history: []
        }),
        createImageAlias: async (args: any) => {
          createdAliases.push(args);
          return args;
        }
      };

      const mockCreds: any = {
        getApiKey: async () => 'bl_live_test_key',
        getRestUrl: () => 'https://api.boxlite.ai'
      };
      const mockTreeProvider: any = { refresh: () => {} };
      const mockImagesProvider: any = { refresh: () => {} };

      registerCommands(
        { subscriptions: [] } as any,
        mockBridge,
        mockCreds,
        {} as any,
        mockTreeProvider,
        {} as any,
        {} as any,
        undefined,
        mockImagesProvider
      );

      await runUseYourOwnImageFlow({
        bridge: mockBridge,
        credentials: mockCreds,
        treeProvider: mockTreeProvider,
        imagesProvider: mockImagesProvider
      });

      assert.strictEqual(createdBoxArgs.length, 1);
      assert.strictEqual(createdBoxArgs[0].image, 'docker.io/library/python:latest');
      assert.strictEqual(createdBoxArgs[0].name, 'demo');
      assert.strictEqual(createdBoxArgs[0].diskSizeGb, 10);
      assert.strictEqual(createdBoxArgs[0].entrypoint, undefined);
      assert.ok(savedCustomImages.includes('docker.io/library/python:latest'));
      assert.ok(infoMessages.some((m) => m.includes('docker.io/library/python@sha256:c64c687cbea9…')));
      assert.strictEqual(createdAliases.length, 1);
      assert.deepStrictEqual(createdAliases[0], {
        name: 'docker.io/library/python',
        alias: 'stable',
        digest: sampleDigest
      });
    } finally {
      vscode.workspace.getConfiguration = origGetConfiguration;
      vscode.window.showInputBox = origShowInputBox;
      vscode.window.showQuickPick = origShowQuickPick;
      vscode.window.showWarningMessage = origShowWarningMessage;
      vscode.window.showInformationMessage = origShowInformationMessage;
      vscode.window.showErrorMessage = origShowErrorMessage;
    }
  });

  it('caps runUseYourOwnImageFlow immediate start at 10 GB even when boxlite.defaultDisk is configured to 20', async () => {
    const vscode = require('vscode');
    const origGetConfiguration = vscode.workspace.getConfiguration;
    const origShowInputBox = vscode.window.showInputBox;
    const origShowQuickPick = vscode.window.showQuickPick;
    const origShowInformationMessage = vscode.window.showInformationMessage;
    const origShowErrorMessage = vscode.window.showErrorMessage;

    const createdBoxArgs: any[] = [];
    try {
      vscode.workspace.getConfiguration = () => ({
        get: (key: string, def: any) => (key === 'defaultDisk' ? 20 : def),
        update: async () => {}
      });

      let step = 0;
      vscode.window.showInputBox = async () => (++step === 1 ? 'docker.io/library/rileycarney/rc-typing-app:latest' : 'rc-typing');
      vscode.window.showQuickPick = async (items: any[]) => items.find((i) => i.action === 'create');
      vscode.window.showInformationMessage = async () => undefined;
      vscode.window.showErrorMessage = async (msg: string) => {
        assert.fail(`Unexpected error message: ${msg}`);
      };

      const mockBridge: any = {
        createBox: async (args: any) => {
          createdBoxArgs.push(args);
          return {
            boxId: 'box_rc_1',
            name: args.name,
            status: 'running',
            image: 'docker.io/library/rileycarney/rc-typing-app:latest'
          };
        },
        inspectBox: async () => ({
          id: 'box_rc_1',
          image: 'docker.io/library/rileycarney/rc-typing-app:latest'
        }),
        listImages: async () => ({
          images: [{ name: 'docker.io/library/rileycarney/rc-typing-app' }]
        }),
        inspectImage: async () => ({
          name: 'docker.io/library/rileycarney/rc-typing-app',
          versions: [],
          aliases: [],
          history: []
        })
      };

      await runUseYourOwnImageFlow({
        bridge: mockBridge,
        credentials: { getApiKey: async () => 'bl_live_test' } as any,
        treeProvider: { refresh: () => {} } as any
      });

      assert.strictEqual(createdBoxArgs.length, 1);
      assert.strictEqual(createdBoxArgs[0].diskSizeGb, 10);
    } finally {
      vscode.workspace.getConfiguration = origGetConfiguration;
      vscode.window.showInputBox = origShowInputBox;
      vscode.window.showQuickPick = origShowQuickPick;
      vscode.window.showInformationMessage = origShowInformationMessage;
      vscode.window.showErrorMessage = origShowErrorMessage;
    }
  });

  it('surfaces Connect Private Registry action when runUseYourOwnImageFlow hits an image pull refusal', async () => {
    const vscode = require('vscode');
    const origGetConfiguration = vscode.workspace.getConfiguration;
    const origShowInputBox = vscode.window.showInputBox;
    const origShowQuickPick = vscode.window.showQuickPick;
    const origShowErrorMessage = vscode.window.showErrorMessage;
    const origExecuteCommand = vscode.commands.executeCommand;

    const executedCmds: string[] = [];
    const shownErrors: string[] = [];
    const removedNames: string[] = [];

    try {
      vscode.workspace.getConfiguration = () => ({
        get: (_k: string, def: any) => def,
        update: async () => {}
      });

      let step = 0;
      vscode.window.showInputBox = async () => (++step === 1 ? 'acme/api:1.4.0' : 'demo-failed');
      vscode.window.showQuickPick = async (items: any[]) => items.find((i) => i.action === 'create');
      vscode.window.showErrorMessage = async (msg: string, ...buttons: string[]) => {
        shownErrors.push(msg);
        return buttons.includes('Connect Private Registry...')
          ? 'Connect Private Registry...'
          : undefined;
      };
      vscode.commands.executeCommand = async (id: string, ...args: any[]) => {
        executedCmds.push(id);
        if (id !== 'boxlite.addRegistryLogin') {
          return origExecuteCommand(id, ...args);
        }
      };

      const mockBridge: any = {
        createBox: async () => {
          throw new Error(
            "Box state transition failed: Failed to pull image 'acme/api:1.4.0': docker.io refused the pull (UNAUTHORIZED)."
          );
        },
        removeBox: async (target: string) => {
          removedNames.push(target);
          return { boxId: 'box_orphan', removed: true };
        }
      };

      await runUseYourOwnImageFlow({
        bridge: mockBridge,
        credentials: { getApiKey: async () => 'bl_live_test' } as any,
        treeProvider: { refresh: () => {} } as any
      });

      assert.deepStrictEqual(removedNames, ['demo-failed']);
      assert.strictEqual(shownErrors.length, 1);
      assert.ok(shownErrors[0].includes('Leftover box "demo-failed" was automatically removed'));
      assert.deepStrictEqual(executedCmds, ['boxlite.addRegistryLogin']);
    } finally {
      vscode.workspace.getConfiguration = origGetConfiguration;
      vscode.window.showInputBox = origShowInputBox;
      vscode.window.showQuickPick = origShowQuickPick;
      vscode.window.showErrorMessage = origShowErrorMessage;
      vscode.commands.executeCommand = origExecuteCommand;
    }
  });

  it('exposes shortened digest Image child node under BoxesTreeDataProvider pointing to inspectImage', async () => {
    const provider = new BoxesTreeDataProvider({} as any, {} as any);
    const { BoxTreeItem } = require('../src/tree/nodes');
    const boxItem = new BoxTreeItem({
      id: 'box-alpine-1',
      name: 'demo',
      status: 'running',
      image: `docker.io/library/alpine@${sampleDigest}`
    });

    const children = await provider.getChildren(boxItem);
    const imageNode = children.find((c) => c.label === 'Image');
    assert.ok(imageNode, 'Expected Image child node in BoxesTreeDataProvider');
    assert.strictEqual(imageNode.description, 'docker.io/library/alpine@sha256:c64c687cbea9…');
    assert.strictEqual(imageNode.command?.command, 'boxlite.inspectImage');
    assert.deepStrictEqual(imageNode.command?.arguments, ['docker.io/library/alpine']);
  });
});
