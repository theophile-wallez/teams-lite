import { useMemo } from "react";
import { uploadKey, type UploadRef } from "~/lib/gitlab-upload";
import { useController } from "./controller-context";
import { MediaImage } from "./media-image";

/**
 * One picture a merge request's description or comment points at: a screenshot somebody pasted,
 * which GitLab keeps as a project upload.
 *
 * It is the chat image's own component over a different source of bytes, which is the whole of
 * this file: the loading box, the failure sentence and the lightbox are the ones the app already
 * has, and what differs is only that these bytes come from `gitlab_mr_upload` — because GitLab
 * serves an upload to a session or a token and answers a browser 404, and because nothing on
 * this page may be fetched by the browser at all (see `~/lib/gitlab-upload.ts`).
 */
export function GitLabImage(props: {
  upload: UploadRef;
  alt?: string;
  width?: number;
  height?: number;
  className?: string;
}) {
  const controller = useController();
  const { project, secret, filename } = props.upload;
  // Memoized on the upload's own three parts rather than on the object, which the renderer
  // rebuilds out of the node's attributes on every pass.
  const source = useMemo(() => {
    const upload = { project, secret, filename };
    return { key: uploadKey(upload), load: () => controller.loadGitLabUpload(upload) };
  }, [controller, project, secret, filename]);
  return (
    <MediaImage
      // The picture has no address a browser could use — that is the point of it — so the
      // source names the upload and `src` is left to the blob the source resolves to.
      src=""
      source={source}
      alt={props.alt}
      width={props.width}
      height={props.height}
      className={props.className}
    />
  );
}
