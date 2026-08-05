import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ImageUpload01Icon, Loading02Icon } from "@hugeicons/core-free-icons";
import { COMPOSER_IMAGE_TYPES, loadComposerImage } from "~/lib/composer-image";
import { customEmojiNameError } from "~/lib/custom-emoji";
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

// Emoji caps are stricter than the composer's 10 MB: 128 KB and 512 px on a side.
// The type list is shared to keep the accepted formats in sync.
const EMOJI_MAX_BYTES = 128 * 1024;
const EMOJI_MAX_DIMENSION = 512;

type EmojiImage = {
  contentType: (typeof COMPOSER_IMAGE_TYPES)[number];
  width: number;
  height: number;
  dataBase64: string;
  previewUrl: string;
};

function emojiImageError(file: Pick<File, "size" | "type">): string | null {
  if (!COMPOSER_IMAGE_TYPES.includes(file.type as (typeof COMPOSER_IMAGE_TYPES)[number])) {
    return "Select a PNG, JPEG, GIF, or WebP image.";
  }
  if (file.size > EMOJI_MAX_BYTES) {
    return "Select an image that is 128 KiB or smaller.";
  }
  return null;
}

async function loadEmojiImage(file: File): Promise<EmojiImage> {
  const validation = emojiImageError(file);
  if (validation) throw new Error(validation);

  const loaded = await loadComposerImage(file);

  if (loaded.width > EMOJI_MAX_DIMENSION || loaded.height > EMOJI_MAX_DIMENSION) {
    throw new Error("an emoji must be 512 pixels or smaller on a side");
  }

  return {
    contentType: loaded.contentType,
    width: loaded.width,
    height: loaded.height,
    dataBase64: loaded.dataBase64,
    previewUrl: loaded.previewUrl,
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
      await controller.addCustomEmoji({
        name: trimmedName,
        content_type: image?.contentType,
        data_base64: image?.dataBase64,
        width: image?.width,
        height: image?.height,
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
                accept={COMPOSER_IMAGE_TYPES.join(",")}
                className="hidden"
                onChange={(e) => {
                  void pickFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              <p className="text-xs text-text-dim">
                Square images under 128KB and with transparent backgrounds work best.
              </p>
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
