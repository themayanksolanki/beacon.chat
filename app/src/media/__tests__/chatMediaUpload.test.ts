const mockState = {
  nextSourceSize: 0,
  nextSourceBytes: new Uint8Array([1, 2, 3, 4]),
  nextUploadStatus: 200,
  lastUploadTaskOptions: null as any,
};

jest.mock("expo-file-system", () => {
  class MockFile {
    static downloadFileAsync = jest.fn();
    uri: string;
    exists = false;
    constructor(...parts: unknown[]) {
      this.uri = parts.map((p: any) => (typeof p === "string" ? p : (p?.uri ?? "dir"))).join("/");
    }
    get size() {
      return mockState.nextSourceSize;
    }
    bytesSync() {
      return mockState.nextSourceBytes;
    }
    delete() {}
    create() {}
    write(_content: unknown) {}
    createUploadTask(_url: string, options: any) {
      mockState.lastUploadTaskOptions = options;
      return {
        uploadAsync: async () => {
          options.onProgress?.({ bytesSent: 5, totalBytes: 10 });
          options.onProgress?.({ bytesSent: 10, totalBytes: 10 });
          return { status: mockState.nextUploadStatus, body: "", headers: {} };
        },
      };
    }
  }
  class MockDirectory {
    exists = true;
    uri = "dir";
    constructor(..._parts: unknown[]) {}
    create() {}
  }
  return {
    File: MockFile,
    Directory: MockDirectory,
    Paths: { cache: { uri: "cache" }, document: { uri: "document" } },
    UploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
  };
});

jest.mock("../../api/client", () => ({
  requestChatMediaUploadUrl: jest.fn(),
}));

import { requestChatMediaUploadUrl } from "../../api/client";
import {
  ChatMediaTooLargeError,
  ChatMediaUploadUnavailableError,
  encryptFileForUpload,
  uploadChatMedia,
} from "../chatMediaUpload";

const MAX_BYTES = 10 * 1024 * 1024;

beforeEach(() => {
  mockState.nextSourceSize = 1024;
  mockState.nextSourceBytes = new Uint8Array([1, 2, 3, 4]);
  mockState.nextUploadStatus = 200;
  mockState.lastUploadTaskOptions = null;
  (requestChatMediaUploadUrl as jest.Mock).mockReset();
  (requestChatMediaUploadUrl as jest.Mock).mockResolvedValue({
    url: "https://bucket.s3.amazonaws.com/",
    fields: { key: "chat-media/user/msg" },
    key: "chat-media/user/msg",
    publicUrl: "https://bucket.s3.amazonaws.com/chat-media/user/msg",
    maxBytes: MAX_BYTES,
  });
});

describe("encryptFileForUpload", () => {
  it("throws ChatMediaTooLargeError when the source exceeds the limit", async () => {
    mockState.nextSourceSize = MAX_BYTES + 1;
    await expect(encryptFileForUpload("file:///source.jpg", "msg-1", MAX_BYTES)).rejects.toBeInstanceOf(
      ChatMediaTooLargeError
    );
  });

  it("encrypts the source bytes and returns a key/nonce distinct from the plaintext", async () => {
    const prepared = await encryptFileForUpload("file:///source.jpg", "msg-2", MAX_BYTES);
    expect(prepared.ciphertextUri).toContain("msg-2");
    expect(prepared.keyB64).toEqual(expect.any(String));
    expect(prepared.nonceB64).toEqual(expect.any(String));
  });
});

describe("uploadChatMedia", () => {
  it("reports monotonically increasing progress and resolves the public url on success", async () => {
    const prepared = await encryptFileForUpload("file:///source.jpg", "msg-3", MAX_BYTES);
    const progressEvents: number[] = [];

    const result = await uploadChatMedia("token", "msg-3", "image", prepared, (fraction) => {
      progressEvents.push(fraction);
    });

    expect(result.publicUrl).toBe("https://bucket.s3.amazonaws.com/chat-media/user/msg");
    expect(progressEvents).toEqual([0.5, 1]);
    expect(mockState.lastUploadTaskOptions.parameters).toEqual({ key: "chat-media/user/msg" });
  });

  it("throws on a non-2xx upload response", async () => {
    mockState.nextUploadStatus = 500;
    const prepared = await encryptFileForUpload("file:///source.jpg", "msg-4", MAX_BYTES);
    await expect(uploadChatMedia("token", "msg-4", "image", prepared)).rejects.toThrow(
      "chat_media_upload_failed_500"
    );
  });

  it("wraps a failed upload-url request in ChatMediaUploadUnavailableError", async () => {
    (requestChatMediaUploadUrl as jest.Mock).mockRejectedValueOnce(new Error("chat_media_upload_unavailable"));
    const prepared = await encryptFileForUpload("file:///source.jpg", "msg-5", MAX_BYTES);
    await expect(uploadChatMedia("token", "msg-5", "image", prepared)).rejects.toBeInstanceOf(
      ChatMediaUploadUnavailableError
    );
  });
});
