import * as vscode from 'vscode';
import { BoxLiteBridgeClient } from '../bridge/client';
import {
  CreateBoxArgs,
  CreateBoxResult,
  ImageDetail,
  ImageItem,
  ImageUsage
} from '../bridge/protocol';
import { CredentialsManager } from '../auth/credentials';
import { SecretsManager } from '../auth/secretsStore';
import { BoxesTreeDataProvider } from '../tree/boxesProvider';
import { ImagesTreeDataProvider } from '../tree/imagesProvider';
import { formatBytes } from '../tree/nodes';
import {
  convertBoxConfigToCreateArgs,
  generateBoxName,
  getDefaultBoxConfiguration,
  showBoxConfigurationWizard
} from '../commands/boxConfiguration';
import {
  DiagnosticMessage,
  diagnoseError,
  formatErrorWithDiagnosis,
  isImageCatalogLimitError,
  isImagePullError
} from '../util/diagnosis';
import {
  extractImageDigest,
  formatShortImageReference,
  imageReferencesMatch,
  parseImageReference,
  validateImageReference
} from '../util/validation';

export const DEFAULT_CATALOG_POLL_ATTEMPTS = 10;
export const DEFAULT_CATALOG_POLL_INTERVAL_MS = 4000;

export interface CatalogPollOptions {
  maxAttempts?: number;
  intervalMs?: number;
  initialBoxImage?: string;
  sleep?: (ms: number) => Promise<void>;
  isCancelled?: () => boolean;
  onAttempt?: (attempt: number, maxAttempts: number) => void;
}

export interface CatalogPollResult {
  recorded: boolean;
  attempts: number;
  catalogImage?: ImageItem;
  detail?: ImageDetail;
  usage?: ImageUsage;
  resolvedBoxImage?: string;
  digest?: string;
}

export interface CleanupResult {
  cleanedUp: boolean;
  notFound?: boolean;
  error?: string;
}

export class ImagePullFailureError extends Error {
  public readonly imageRef: string;
  public readonly boxName?: string;
  public readonly cleanedUp: boolean;
  public readonly cleanupNotFound: boolean;
  public readonly cleanupError?: string;
  public readonly originalError: unknown;
  public readonly diagnosis: DiagnosticMessage;

  constructor(params: {
    imageRef: string;
    boxName?: string;
    cleanup: CleanupResult;
    originalError: unknown;
  }) {
    const rawMsg =
      params.originalError instanceof Error
        ? params.originalError.message
        : String(params.originalError ?? 'Image pull failed');
    super(rawMsg);
    this.name = 'ImagePullFailureError';
    this.imageRef = params.imageRef;
    this.boxName = params.boxName;
    this.cleanedUp = params.cleanup.cleanedUp;
    this.cleanupNotFound = Boolean(params.cleanup.notFound);
    this.cleanupError = params.cleanup.error;
    this.originalError = params.originalError;
    this.diagnosis = diagnoseError(rawMsg);
  }
}

export interface LaunchBoxFromOwnImageOptions {
  pollOptions?: CatalogPollOptions;
  onBoxCreated?: (box: CreateBoxResult) => void | Promise<void>;
}

export interface LaunchBoxFromOwnImageResult {
  box: CreateBoxResult;
  catalog: CatalogPollResult;
}

export interface CustomImageWorkflowDeps {
  bridge: BoxLiteBridgeClient;
  credentials: CredentialsManager;
  treeProvider: BoxesTreeDataProvider;
  imagesProvider?: ImagesTreeDataProvider;
  secretsManager?: SecretsManager;
  outputChannel?: vscode.OutputChannel;
}

export function buildSuggestedBoxNameForImage(imageRef: string): string {
  const parsed = parseImageReference(imageRef);
  const baseRepo = (parsed.repository || parsed.canonicalName || imageRef || '').trim();
  const lastSegment = baseRepo.split('/').filter(Boolean).pop() || 'demo';
  const cleaned = lastSegment
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return generateBoxName(cleaned || 'demo');
}

function isAuthError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err || '')).toLowerCase();
  return (
    msg.includes('401') ||
    msg.includes('unauthorized') ||
    msg.includes('403') ||
    msg.includes('forbidden')
  );
}

function isConflictOrLimitError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err || '')).toLowerCase();
  return (
    isImageCatalogLimitError(msg) ||
    /\b409\b/.test(msg) ||
    msg.includes('conflict') ||
    msg.includes('already exists')
  );
}

async function inspectBoxImageBestEffort(
  bridge: BoxLiteBridgeClient,
  boxId: string,
  currentResolved?: string
): Promise<string | undefined> {
  if (currentResolved && extractImageDigest(currentResolved)) {
    return currentResolved;
  }
  if (typeof bridge.inspectBox !== 'function') {
    return currentResolved;
  }
  try {
    const info = await bridge.inspectBox(boxId);
    const raw = info?.image || info?.config?.image;
    if (typeof raw === 'string' && raw.trim().length > 0) {
      return raw.trim();
    }
  } catch {
    // Ignore transient inspect failures during boot polling
  }
  return currentResolved;
}

/**
 * Polls the Cloud image catalog after booting a box because catalog recording
 * occurs when the microVM finishes booting (~12 seconds in measured runs).
 */
export async function pollCatalogForImage(
  bridge: BoxLiteBridgeClient,
  imageRef: string,
  boxId: string,
  options: CatalogPollOptions = {}
): Promise<CatalogPollResult> {
  const trimmedRef = (imageRef || '').trim();
  let resolvedBoxImage = options.initialBoxImage;

  if (!trimmedRef) {
    resolvedBoxImage = await inspectBoxImageBestEffort(bridge, boxId, resolvedBoxImage);
    return {
      recorded: false,
      attempts: 0,
      resolvedBoxImage,
      digest: extractImageDigest(resolvedBoxImage)
    };
  }

  const parsed = parseImageReference(trimmedRef);

  if (parsed.isBuiltin) {
    resolvedBoxImage = await inspectBoxImageBestEffort(bridge, boxId, resolvedBoxImage);
    return {
      recorded: false,
      attempts: 0,
      resolvedBoxImage,
      digest: extractImageDigest(resolvedBoxImage)
    };
  }

  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_CATALOG_POLL_ATTEMPTS);
  const intervalMs = Math.max(0, options.intervalMs ?? DEFAULT_CATALOG_POLL_INTERVAL_MS);
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let attemptsRun = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.isCancelled?.()) {
      break;
    }

    attemptsRun = attempt;
    options.onAttempt?.(attempt, maxAttempts);

    resolvedBoxImage = await inspectBoxImageBestEffort(bridge, boxId, resolvedBoxImage);

    let listRes: { images: ImageItem[]; usage?: ImageUsage } | undefined;
    try {
      listRes = await bridge.listImages();
    } catch (err) {
      if (isAuthError(err)) {
        throw err;
      }
      listRes = undefined;
    }

    const targetCatalogName = parsed.canonicalName || imageRef;
    const matched = (listRes?.images || []).find(
      (img) => typeof img?.name === 'string' && imageReferencesMatch(img.name, targetCatalogName)
    );

    if (matched) {
      let detail: ImageDetail | undefined;
      if (typeof bridge.inspectImage === 'function') {
        try {
          detail = await bridge.inspectImage(matched.name || targetCatalogName);
        } catch {
          // Optional catalog detail inspection; list entry already confirmed recording
        }
      }

      const digest =
        extractImageDigest(resolvedBoxImage) ||
        matched.digest ||
        (detail?.versions && detail.versions[0]?.digest) ||
        undefined;

      return {
        recorded: true,
        attempts: attempt,
        catalogImage: matched,
        detail,
        usage: listRes?.usage,
        resolvedBoxImage,
        digest
      };
    }

    if (attempt < maxAttempts && !options.isCancelled?.() && intervalMs > 0) {
      await sleep(intervalMs);
    }
  }

  return {
    recorded: false,
    attempts: attemptsRun,
    resolvedBoxImage,
    digest: extractImageDigest(resolvedBoxImage)
  };
}

/**
 * A create that fails on its image still leaves the box behind without returning its ID.
 * Removes any leftover box by the name passed to create().
 */
export async function cleanupFailedImageBox(
  bridge: BoxLiteBridgeClient,
  boxName: string
): Promise<CleanupResult> {
  const trimmed = (boxName || '').trim();
  if (!trimmed) {
    return { cleanedUp: false, notFound: true };
  }
  try {
    const res = await bridge.removeBox(trimmed, { ignoreNotFound: true });
    return {
      cleanedUp: Boolean(res?.removed),
      notFound: Boolean(res?.notFound)
    };
  } catch (err) {
    return {
      cleanedUp: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

export async function launchBoxFromOwnImage(
  bridge: BoxLiteBridgeClient,
  createArgs: CreateBoxArgs,
  options: LaunchBoxFromOwnImageOptions = {}
): Promise<LaunchBoxFromOwnImageResult> {
  let created: CreateBoxResult;
  try {
    created = await bridge.createBox(createArgs);
  } catch (err) {
    if (isImagePullError(err) && !isConflictOrLimitError(err)) {
      const cleanup = createArgs.name
        ? await cleanupFailedImageBox(bridge, createArgs.name)
        : { cleanedUp: false, notFound: true };
      throw new ImagePullFailureError({
        imageRef: createArgs.image || '',
        boxName: createArgs.name,
        cleanup,
        originalError: err
      });
    }
    throw err;
  }

  if (options.onBoxCreated) {
    await options.onBoxCreated(created);
  }

  const catalog = await pollCatalogForImage(bridge, createArgs.image || '', created.boxId, {
    ...options.pollOptions,
    initialBoxImage: created.image || options.pollOptions?.initialBoxImage
  });

  return { box: created, catalog };
}

export async function handleImagePullFailureUi(
  err: ImagePullFailureError,
  deps: Pick<CustomImageWorkflowDeps, 'bridge' | 'treeProvider' | 'outputChannel'>,
  options?: { retryCallback?: (imageRef: string) => Promise<void> }
): Promise<void> {
  deps.treeProvider.refresh();

  try {
    deps.outputChannel?.appendLine(`[images] Pull failed for "${err.imageRef}": ${err.message}`);
    for (const line of err.diagnosis.checklist) {
      deps.outputChannel?.appendLine(`[images]   - ${line}`);
    }
  } catch {
    // Ignore output channel errors
  }

  let cleanupNote = '';
  if (err.boxName) {
    if (err.cleanedUp) {
      cleanupNote = ` Leftover box "${err.boxName}" was automatically removed.`;
    } else if (err.cleanupNotFound) {
      cleanupNote = ` No leftover box named "${err.boxName}" remained.`;
    } else {
      cleanupNote = ` Leftover box "${err.boxName}" may remain (auto-cleanup failed${
        err.cleanupError ? `: ${err.cleanupError}` : ''
      }).`;
    }
  }

  const summaryMsg =
    `Failed to pull image "${err.imageRef}". ` +
    `Likely causes: (1) typo in reference, (2) private image without a matching registry login, or (3) tag does not exist.` +
    cleanupNote;

  const buttons: string[] = [];
  if (err.boxName && !err.cleanedUp && !err.cleanupNotFound) {
    buttons.push('Remove Leftover Box');
  }
  buttons.push('Connect Private Registry...');
  if (options?.retryCallback) {
    buttons.push('Try Again');
  }

  const choice = await vscode.window.showErrorMessage(summaryMsg, ...buttons);
  if (choice === 'Remove Leftover Box' && err.boxName) {
    try {
      await deps.bridge.removeBox(err.boxName, { ignoreNotFound: true });
      deps.treeProvider.refresh();
      vscode.window.showInformationMessage(`Removed leftover box "${err.boxName}".`);
    } catch (rmErr: any) {
      vscode.window.showErrorMessage(`Could not remove box "${err.boxName}": ${rmErr.message}`);
    }
  } else if (choice === 'Connect Private Registry...') {
    await vscode.commands.executeCommand('boxlite.addRegistryLogin');
  } else if (choice === 'Try Again' && options?.retryCallback) {
    await options.retryCallback(err.imageRef);
  }
}

async function saveCustomImageSetting(imageRef: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('boxlite');
  const current = config.get<string[]>('customImages', []);
  if (!current.some((x) => typeof x === 'string' && x.toLowerCase() === imageRef.toLowerCase())) {
    await config.update('customImages', [...current, imageRef], vscode.ConfigurationTarget.Global);
  }
}

export async function runUseYourOwnImageFlow(
  deps: CustomImageWorkflowDeps,
  initialImageRef?: string
): Promise<void> {
  const apiKey = await deps.credentials.getApiKey();
  if (!apiKey) {
    const signIn = await vscode.window.showWarningMessage(
      'Please sign in to BoxLite Cloud first to use your own image.',
      'Sign In / Set API Key'
    );
    if (signIn === 'Sign In / Set API Key') {
      await vscode.commands.executeCommand('boxlite.setApiKey');
    }
    return;
  }

  let currentInput = initialImageRef || '';
  let imageRef: string | undefined;

  while (true) {
    const input = await vscode.window.showInputBox({
      title: 'Use Your Own Image',
      prompt:
        'Enter any public or private OCI image reference (short names default to Docker Hub; e.g. alpine -> docker.io/library/alpine:latest, or docker.io/library/python:3.12-slim)',
      placeHolder: 'e.g. docker.io/library/alpine:3.20 or ghcr.io/acme/api:1.4.0',
      value: currentInput,
      ignoreFocusOut: true,
      validateInput: (v) => {
        const check = validateImageReference(v);
        return check.valid ? null : check.error || 'Invalid image reference';
      }
    });

    if (!input || !input.trim()) {
      return;
    }

    currentInput = input.trim();
    const parsed = parseImageReference(currentInput);

    if (parsed.isBuiltin) {
      const dockerHubRef = `docker.io/library/${parsed.canonicalName}:latest`;
      const useDockerHub = `Use Docker Hub (${dockerHubRef})`;
      const useBuiltin = `Use BoxLite Built-in (${parsed.canonicalName})`;
      const choice = await vscode.window.showWarningMessage(
        `'${currentInput}' refers to BoxLite's built-in image, not Docker Hub's. To boot Docker Hub's image, use a full reference such as '${dockerHubRef}' (or e.g. 'docker.io/library/python:3.12-slim').`,
        { modal: true },
        useDockerHub,
        useBuiltin,
        'Edit Reference'
      );
      if (choice === useDockerHub) {
        imageRef = dockerHubRef;
        break;
      }
      if (choice === useBuiltin) {
        imageRef = parsed.canonicalName;
        break;
      }
      if (choice === 'Edit Reference') {
        continue;
      }
      return;
    }

    imageRef = currentInput;
    break;
  }

  const parsed = parseImageReference(imageRef);
  const resolvedLine =
    !parsed.isBuiltin && parsed.resolvedRef !== imageRef
      ? `Resolves to ${parsed.resolvedRef} · Catalog: ${parsed.canonicalName}`
      : parsed.isBuiltin
      ? 'BoxLite Built-in image (free · not recorded in catalog)'
      : `Catalog: ${parsed.canonicalName}`;

  const action = await vscode.window.showQuickPick(
    [
      {
        label: '$(play) Start Box Now & Record in Catalog',
        description: parsed.isBuiltin
          ? 'Boots BoxLite built-in image without catalog quota'
          : 'Creates & starts box, then polls catalog (~12s) for digest record',
        detail: resolvedLine,
        action: 'create' as const
      },
      {
        label: '$(gear) Configure Box Options First...',
        description: 'Customize CPU, RAM, disk, network policy, env vars, and secrets',
        detail: resolvedLine,
        action: 'configure' as const
      },
      {
        label: '$(save) Save to Custom Image List Only',
        description: 'Keep in Images sidebar without starting a box now',
        detail: resolvedLine,
        action: 'save' as const
      }
    ],
    {
      title: `Use Your Own Image: ${imageRef}`,
      placeHolder: resolvedLine
    }
  );

  if (!action) {
    return;
  }

  if (!parsed.isBuiltin) {
    await saveCustomImageSetting(imageRef);
  }

  if (action.action === 'save') {
    deps.imagesProvider?.refresh();
    vscode.window.showInformationMessage(`Image "${imageRef}" saved to your custom images list.`);
    return;
  }

  let createArgs: CreateBoxArgs | undefined;
  if (action.action === 'create') {
    const suggestedName = buildSuggestedBoxNameForImage(imageRef);
    const boxName = await vscode.window.showInputBox({
      title: `Name Your Box (${imageRef})`,
      prompt: 'Enter a unique box name (also used to clean up automatically if image pull fails)',
      value: suggestedName,
      ignoreFocusOut: true,
      validateInput: (v) =>
        !v || !v.trim() ? 'Box name cannot be empty' : null
    });
    if (!boxName || !boxName.trim()) {
      return;
    }
    const defaults = getDefaultBoxConfiguration();
    createArgs = convertBoxConfigToCreateArgs({
      ...defaults,
      name: boxName.trim(),
      image: imageRef,
      entrypointPreset: parsed.isBuiltin ? 'supervisor' : 'default'
    });
  } else {
    createArgs = await showBoxConfigurationWizard(
      {
        image: imageRef,
        name: buildSuggestedBoxNameForImage(imageRef),
        entrypointPreset: parsed.isBuiltin ? 'supervisor' : 'default'
      },
      deps.secretsManager
    );
  }

  if (!createArgs) {
    return;
  }

  let launchResult: LaunchBoxFromOwnImageResult | undefined;
  let launchError: unknown;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Starting Box "${createArgs.name || 'box'}" from ${imageRef}...`,
      cancellable: true
    },
    async (progress, token) => {
      try {
        progress?.report({ message: 'Creating and booting microVM via BoxLite API...' });
        launchResult = await launchBoxFromOwnImage(deps.bridge, createArgs!, {
          onBoxCreated: async (created) => {
            deps.treeProvider.refresh();
            deps.imagesProvider?.refresh();
            try {
              deps.outputChannel?.appendLine(
                `[images] Started box ${created.boxId} (${created.name}) with image "${created.image || imageRef}"`
              );
            } catch {
              // Ignore output channel errors
            }
            if (!parsed.isBuiltin) {
              progress?.report({
                message: `Box ${created.boxId} started — waiting for catalog recording (~12s)...`
              });
            }
          },
          pollOptions: {
            isCancelled: () => Boolean(token?.isCancellationRequested),
            onAttempt: (attempt, max) => {
              progress?.report({
                message: `Polling catalog for ${parsed.canonicalName} (${attempt}/${max})...`
              });
            }
          }
        });
      } catch (err) {
        launchError = err;
      }
    }
  );

  deps.treeProvider.refresh();
  deps.imagesProvider?.refresh();

  if (launchError) {
    if (launchError instanceof ImagePullFailureError) {
      await handleImagePullFailureUi(launchError, deps, {
        retryCallback: (failedRef) => runUseYourOwnImageFlow(deps, failedRef)
      });
      return;
    }
    const msg = formatErrorWithDiagnosis(launchError);
    vscode.window.showErrorMessage(`Failed to start Box from "${imageRef}": ${msg}`);
    return;
  }

  if (!launchResult) {
    return;
  }

  const { box, catalog } = launchResult;
  const readbackRef = catalog.resolvedBoxImage || box.image;
  const displayReadback = readbackRef
    ? formatShortImageReference(readbackRef)
    : catalog.digest
    ? `${parsed.canonicalName}@${catalog.digest.slice(0, 19)}…`
    : imageRef;

  const usageSummary = catalog.usage
    ? ` (${catalog.usage.count} of ${catalog.usage.limit} images · ${formatBytes(catalog.usage.knownBytes)})`
    : '';

  if (parsed.isBuiltin) {
    const choice = await vscode.window.showInformationMessage(
      `Box "${box.name}" started (${box.boxId}) using built-in image "${parsed.canonicalName}" (free · not counted).`,
      'Inspect Box'
    );
    if (choice === 'Inspect Box') {
      await vscode.commands.executeCommand('boxlite.inspectBox', box.boxId);
    }
    return;
  }

  if (catalog.recorded) {
    const choice = await vscode.window.showInformationMessage(
      `Box "${box.name}" (${box.boxId}) booted and recorded "${parsed.canonicalName}" in catalog${usageSummary}. Image: ${displayReadback}`,
      'Pin Alias...',
      'Inspect Catalog Entry',
      'Inspect Box'
    );
    if (choice === 'Pin Alias...') {
      await vscode.commands.executeCommand(
        'boxlite.pinImageAlias',
        catalog.catalogImage?.name || parsed.canonicalName,
        catalog.digest
      );
    } else if (choice === 'Inspect Catalog Entry') {
      const detail =
        catalog.detail ||
        (await deps.bridge.inspectImage(catalog.catalogImage?.name || parsed.canonicalName));
      const doc = await vscode.workspace.openTextDocument({
        content: JSON.stringify(detail, null, 2),
        language: 'json'
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    } else if (choice === 'Inspect Box') {
      await vscode.commands.executeCommand('boxlite.inspectBox', box.boxId);
    }
  } else {
    const choice = await vscode.window.showInformationMessage(
      `Box "${box.name}" (${box.boxId}) started with ${displayReadback}. Catalog recording occurs after boot (~12s) and will appear in Images once finished.`,
      'Refresh Catalog',
      'Inspect Box'
    );
    if (choice === 'Refresh Catalog') {
      deps.imagesProvider?.refresh();
    } else if (choice === 'Inspect Box') {
      await vscode.commands.executeCommand('boxlite.inspectBox', box.boxId);
    }
  }
}
