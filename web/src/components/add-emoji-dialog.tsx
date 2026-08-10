import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ImageUpload01Icon, Loading02Icon } from "@hugeicons/core-free-icons";
import {
  COMPOSER_IMAGE_TYPES,
  loadComposerImage,
  type ComposerImage,
} from "~/lib/composer-image";
import {
  EMOJI_MAX_BYTES,
  EMOJI_SHRINK_DIMENSION,
  customEmojiNameError,
  emojiOversize,
} from "~/lib/custom-emoji";
import { cn } from "~/lib/utils";
import { useController } from "./controller-context";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Tabs, TabsPanel, TabsList, TabsTrigger } from "./ui/tabs";

/** A picture picked for an emoji: the composer's own, plus the one fact only this path
 *  has — the size it ARRIVED at, when it had to be redrawn smaller to fit. The dialog
 *  states that, because reducing what somebody handed the app without saying so is the
 *  app quietly changing their art. */
type EmojiImage = ComposerImage & { shrunkFrom?: { width: number; height: number } };

/** `source` redrawn into `box`, as a PNG data URL.
 *
 *  PNG whatever the source was, because an emoji lives on its transparency and a JPEG
 *  would flatten it onto black — the type the picture is STORED as is what comes back out
 *  of this app inside an `<img>`, so it has to be the type the canvas really wrote. */
function redrawSmaller(
  source: string,
  box: { width: number; height: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error("Could not decode the image."));
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = box.width;
      canvas.height = box.height;
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("This browser cannot resize an image."));
        return;
      }
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, box.width, box.height);
      resolve(canvas.toDataURL("image/png"));
    };
    image.src = source;
  });
}

/** How many bytes a base64 payload decodes to — what the caps are counted in, and the
 *  only thing that says whether a redraw really got under them. */
function decodedBytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/**
 * A picture picked for an emoji, brought inside the EMOJI's own caps.
 *
 * The accepted TYPES and the composer's own 10 MB ceiling are `loadComposerImage`'s
 * checks, in its own sentences, so a copy of them here would type-check every file twice
 * to say the same thing. What belongs to the emoji is the 128 KB and the 512 px — and a
 * picture over either one is SHRUNK rather than refused, the way Slack reduces an
 * over-size upload, so nobody is sent out to an image editor for a glyph that will be
 * drawn at 20 px. The backend's own measurement is still the check that holds
 * (`custom_emoji::measure_art`, which reads the bytes this function ends up sending);
 * the shrink is what stops it from having to refuse one.
 */
async function loadEmojiImage(file: File): Promise<EmojiImage> {
  const loaded = await loadComposerImage(file);
  const oversize = emojiOversize(loaded);
  if (oversize === null) return loaded;
  if ("error" in oversize) throw new Error(oversize.error);

  const previewUrl = await redrawSmaller(loaded.previewUrl, oversize.shrinkTo);
  const marker = ";base64,";
  const dataBase64 = previewUrl.slice(previewUrl.indexOf(marker) + marker.length);
  const bytes = decodedBytes(dataBase64);
  // Unreachable for a 128 px box — 128x128 of raw RGBA is 64 KB — but the caps are the
  // backend's invariant, so the dialog never sends a picture it has not checked itself.
  if (bytes > EMOJI_MAX_BYTES) {
    throw new Error(`That image is still over ${EMOJI_MAX_BYTES / 1024} KB once shrunk.`);
  }

  return {
    ...loaded,
    contentType: "image/png",
    width: oversize.shrinkTo.width,
    height: oversize.shrinkTo.height,
    bytes,
    dataBase64,
    previewUrl,
    shrunkFrom: { width: loaded.width, height: loaded.height },
  };
}

export function AddEmojiDialog(props: {
  open: boolean;
  onClose: () => void;
  initialName?: string;
  initialUrl?: string;
}) {
  const controller = useController();
  const [activeTab, setActiveTab] = useState("upload");
  const [name, setName] = useState("");
  const [image, setImage] = useState<EmojiImage | null>(null);
  const [url, setUrl] = useState("");
  const [packFile, setPackFile] = useState<File | null>(null);
  const [packCount, setPackCount] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [takenNames, setTakenNames] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const packInput = useRef<HTMLInputElement>(null);
  const nameField = useRef<HTMLInputElement>(null);

  // Load taken names when dialog opens
  useEffect(() => {
    if (!props.open) return;
    let alive = true;
    setActiveTab("upload");
    setName(props.initialName ?? "");
    setImage(null);
    setUrl(props.initialUrl ?? "");
    setPackFile(null);
    setPackCount(null);
    setError(null);
    controller
      .loadCustomEmoji()
      .then((pack) => {
        if (!alive) return;
        setTakenNames(pack.map((e) => e.name));
      })
      .catch(() => {
        if (alive) setTakenNames([]);
      });
    return () => {
      alive = false;
    };
  }, [controller, props.open, props.initialName, props.initialUrl]);

  async function pickFile(file: File | undefined): Promise<void> {
    if (!file) return;
    setError(null);
    setUrl("");
    try {
      setImage(await loadEmojiImage(file));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that image.");
    }
  }

  async function handlePaste(e: React.ClipboardEvent): Promise<void> {
    const file = e.clipboardData.files[0];
    if (file) {
      e.preventDefault();
      await pickFile(file);
    }
  }

  async function pickPackFile(file: File | undefined): Promise<void> {
    if (!file) return;
    setError(null);
    setPackCount(null);
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      if (!json.emoji || !Array.isArray(json.emoji)) {
        throw new Error("The pack file is not in the expected format.");
      }
      setPackFile(file);
      setPackCount(json.emoji.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that pack file.");
    }
  }

  const trimmedName = name.trim();
  const nameError = trimmedName ? customEmojiNameError(trimmedName, takenNames) : null;
  const canSaveUpload = trimmedName && !nameError && (image || url);
  const canSavePackImport = packFile && packCount !== null && packCount > 0;

  async function saveUpload(): Promise<void> {
    if (!canSaveUpload) return;
    setSaving(true);
    setError(null);
    try {
      const isFromMessage = props.initialUrl && url === props.initialUrl;
      // Only the BYTES travel: the backend sniffs the type and reads the dimensions out of
      // them (`custom_emoji::measure_art`) and never reads what a client claimed, so
      // sending those three was sending fields nothing on the other side looks at.
      await controller.addCustomEmoji({
        name: trimmedName,
        data_base64: image?.dataBase64,
        url: isFromMessage ? undefined : url || undefined,
        media_url: isFromMessage ? url : undefined,
        source: isFromMessage ? "message" : url ? "url" : "upload",
      });
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add that emoji.");
    } finally {
      setSaving(false);
    }
  }

  async function savePackImport(): Promise<void> {
    if (!canSavePackImport || !packFile) return;
    setSaving(true);
    setError(null);
    try {
      const text = await packFile.text();
      const json = JSON.parse(text);
      const added = await controller.importCustomEmoji(json.emoji);
      if (added === 0) {
        setError("No emoji were added. They may already exist in your pack.");
      } else {
        props.onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not import that pack.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent
        data-testid="add-emoji-dialog"
        className="max-w-md"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          nameField.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Add Emoji</DialogTitle>
          <DialogDescription>
            Upload your own emoji or import a pack from another workspace.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList aria-label="Add emoji tabs" className="grid w-full grid-cols-2">
            <TabsTrigger value="upload" data-testid="add-emoji-tab-upload">
              Upload Image
            </TabsTrigger>
            <TabsTrigger value="packs" data-testid="add-emoji-tab-packs">
              Emoji packs
            </TabsTrigger>
          </TabsList>

          <TabsPanel value="upload" className="space-y-4">
            <div className="space-y-2">
              <div
                role="button"
                tabIndex={0}
                data-testid="add-emoji-dropzone"
                onPaste={(e) => void handlePaste(e)}
                onClick={() => fileInput.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    fileInput.current?.click();
                  }
                }}
                className={cn(
                  "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-border bg-bg-secondary p-8 text-center transition-colors hover:border-text-dim hover:bg-bg-tertiary",
                  image && "border-solid bg-bg-primary",
                )}
              >
                {image ? (
                  <img
                    src={image.previewUrl}
                    alt="Preview"
                    className="size-16 object-contain"
                  />
                ) : (
                  <>
                    <HugeiconsIcon
                      icon={ImageUpload01Icon}
                      className="size-8 text-text-dim"
                      strokeWidth={1.5}
                    />
                    <p className="text-sm text-text-primary">
                      Click to upload or paste an image
                    </p>
                  </>
                )}
              </div>
              <input
                ref={fileInput}
                type="file"
                data-testid="add-emoji-image-input"
                accept={COMPOSER_IMAGE_TYPES.join(",")}
                className="hidden"
                onChange={(e) => {
                  void pickFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              {image?.shrunkFrom ? (
                <p data-testid="add-emoji-shrunk" className="text-xs text-text-dim">
                  Shrunk from {image.shrunkFrom.width}×{image.shrunkFrom.height} to{" "}
                  {image.width}×{image.height} to fit.
                </p>
              ) : (
                <p className="text-xs text-text-dim">
                  Anything bigger is shrunk to {EMOJI_SHRINK_DIMENSION} px. Square images
                  with transparent backgrounds work best.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <label htmlFor="emoji-url" className="text-xs font-medium text-text-dim">
                Or paste an image URL
              </label>
              <Input
                id="emoji-url"
                type="url"
                placeholder="https://example.com/image.png"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  if (e.target.value) setImage(null);
                }}
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="emoji-name" className="text-xs font-medium text-text-dim">
                Give it a name
              </label>
              <div className="flex items-center gap-1">
                <span className="text-text-dim">:</span>
                <Input
                  ref={nameField}
                  id="emoji-name"
                  type="text"
                  data-testid="add-emoji-name"
                  value={name}
                  maxLength={64}
                  placeholder="emoji-name"
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canSaveUpload && !saving) void saveUpload();
                  }}
                  className="flex-1"
                />
                <span className="text-text-dim">:</span>
              </div>
            </div>

            {image && trimmedName && !nameError && (
              <div className="flex items-center gap-3 rounded-md border border-border bg-bg-secondary p-3">
                <img
                  src={image.previewUrl}
                  alt={trimmedName}
                  className="size-5 object-contain"
                />
                <p className="text-sm text-text-dim">
                  Preview: <span className="text-text-primary">:{trimmedName}:</span> will look
                  like this in messages
                </p>
              </div>
            )}

            {error && (
              <p data-testid="add-emoji-error" className="text-xs text-destructive">
                {error}
              </p>
            )}
            {nameError && (
              <p data-testid="add-emoji-error" className="text-xs text-destructive">
                {nameError}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => props.onClose()}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                type="button"
                data-testid="add-emoji-save"
                onClick={() => void saveUpload()}
                disabled={!canSaveUpload || saving}
              >
                {saving && (
                  <HugeiconsIcon icon={Loading02Icon} className="animate-spin" strokeWidth={1.8} />
                )}
                Save
              </Button>
            </div>
          </TabsPanel>

          <TabsPanel value="packs" className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm text-text-dim">
                Import emoji from a pack file exported from another teams-lite workspace or
                Slack.
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => packInput.current?.click()}
                className="w-full"
              >
                <HugeiconsIcon icon={ImageUpload01Icon} strokeWidth={1.8} />
                Choose Pack File
              </Button>
              <input
                ref={packInput}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  void pickPackFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              {packFile && packCount !== null && (
                <p className="text-sm text-text-primary">
                  {packFile.name} contains {packCount} emoji
                </p>
              )}
            </div>

            {error && (
              <p data-testid="add-emoji-error" className="text-xs text-destructive">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => props.onClose()}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void savePackImport()}
                disabled={!canSavePackImport || saving}
              >
                {saving && (
                  <HugeiconsIcon icon={Loading02Icon} className="animate-spin" strokeWidth={1.8} />
                )}
                Add Pack
              </Button>
            </div>
          </TabsPanel>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
