export interface SupportedDocumentType {
  mime: string;
  extensions: string[];
}

// Chat apps generally scope a "document" attachment to office/text formats
// rather than any arbitrary file (archives, executables, etc.) — this is
// also why Documents is a separate AttachmentSheet entry from the generic
// file pipeline Audio already uses (see ChatScreen's pickAndSendDocument).
export const SUPPORTED_DOCUMENT_TYPES: SupportedDocumentType[] = [
  { mime: "application/pdf", extensions: [".pdf"] },
  { mime: "application/msword", extensions: [".doc"] },
  { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extensions: [".docx"] },
  { mime: "application/vnd.ms-excel", extensions: [".xls"] },
  { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extensions: [".xlsx"] },
  { mime: "application/vnd.ms-powerpoint", extensions: [".ppt"] },
  { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", extensions: [".pptx"] },
  { mime: "application/vnd.oasis.opendocument.text", extensions: [".odt"] },
  { mime: "text/plain", extensions: [".txt"] },
  { mime: "text/csv", extensions: [".csv"] },
  { mime: "application/rtf", extensions: [".rtf"] },
];

export const DOCUMENT_PICKER_MIME_TYPES = SUPPORTED_DOCUMENT_TYPES.map((t) => t.mime);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

/**
 * True if either the reported mime type or the file's own extension matches
 * a supported document type. Some Android content providers report a
 * generic/missing mime (e.g. "application/octet-stream" or null) for
 * perfectly normal documents, so the extension is checked as a fallback
 * rather than trusting mime alone.
 */
export function isSupportedDocument(mime: string | null | undefined, name: string): boolean {
  const ext = extensionOf(name);
  return SUPPORTED_DOCUMENT_TYPES.some((t) => (!!mime && t.mime === mime) || t.extensions.includes(ext));
}
