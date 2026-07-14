import ReplayKit
import CoreImage
import Darwin

// The Broadcast Upload Extension half of screen sharing. This process runs
// separately from the main Beacon app (a whole separate OS process ReplayKit
// launches once the user confirms "Start Broadcast"), so the only way to get
// captured frames back into the app's WebRTC peer connection is IPC through
// the App Group's shared container — specifically the Unix domain socket
// react-native-webrtc's ScreenCaptureController/ScreenCapturer already bind
// and listen on (as the SERVER) at <AppGroupContainer>/rtc_SSFD once the app
// calls mediaDevices.getDisplayMedia() (see ScreenCaptureController.m /
// ScreenCapturer.m in node_modules/react-native-webrtc/ios/RCTWebRTC). This
// handler is the CLIENT: it connects to that same path and streams frames
// over it. Frame *format* has to match ScreenCapturer.m's Message class
// exactly — an HTTP-response-framed message (parsed via CFHTTPMessage) whose
// headers carry the pixel buffer's width/height/orientation and whose body
// is image data ScreenCapturer.m hands to CIContext.render(toCVPixelBuffer:),
// which accepts any CIImage-decodable format, JPEG included.
final class SampleHandler: RPBroadcastSampleHandler {
    // Must match RTCAppGroupIdentifier in the main app's Info.plist (see
    // app.json's ios.infoPlist) and the com.apple.security.application-groups
    // entitlement on BOTH this extension's and the main app's targets.
    private let appGroupIdentifier = "group.com.beaconchat.app"
    private let socketFileName = "rtc_SSFD"

    private var connection: ExtensionSocketConnection?
    private let ciContext = CIContext(options: nil)

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        guard
            let sharedContainer = FileManager.default.containerURL(
                forSecurityApplicationGroupIdentifier: appGroupIdentifier
            )
        else {
            finishBroadcastWithError(
                NSError(
                    domain: "com.beaconchat.app.BeaconScreenShare",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "App Group container unavailable — check the App Group entitlement/identifier."]
                )
            )
            return
        }

        let socketFilePath = sharedContainer.appendingPathComponent(socketFileName).path
        let connection = ExtensionSocketConnection(filePath: socketFilePath)
        // The app's socket server (ScreenCaptureController.startCapture,
        // triggered by getDisplayMedia()) may not be listening yet the
        // instant this broadcast starts — retry briefly rather than failing
        // outright on the first connect() attempt.
        if !connection.openWithRetry() {
            finishBroadcastWithError(
                NSError(
                    domain: "com.beaconchat.app.BeaconScreenShare",
                    code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "Couldn't reach Beacon — open the call in the app first, then start this broadcast."]
                )
            )
            return
        }
        self.connection = connection
    }

    override func broadcastPaused() {}

    override func broadcastResumed() {}

    override func broadcastFinished() {
        connection?.close()
        connection = nil
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard sampleBufferType == .video, let connection = connection, connection.isOpen else { return }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        guard
            let jpegData = ciContext.jpegRepresentation(
                of: ciImage,
                colorSpace: CGColorSpaceCreateDeviceRGB(),
                options: [:]
            )
        else { return }

        // kCGImagePropertyOrientationUp — ReplayKit frames already arrive
        // right-side-up for the current interface orientation; ScreenCapturer.m
        // only uses this to pick a rotation to hand WebRTC, and passing
        // anything else here would rotate a frame that isn't actually rotated.
        let orientation = 1

        guard
            let response = CFHTTPMessageCreateResponse(kCFAllocatorDefault, 200, nil, kCFHTTPVersion1_1)?
                .takeRetainedValue()
        else { return }
        CFHTTPMessageSetHeaderFieldValue(response, "Content-Length" as CFString, "\(jpegData.count)" as CFString)
        CFHTTPMessageSetHeaderFieldValue(response, "Buffer-Width" as CFString, "\(width)" as CFString)
        CFHTTPMessageSetHeaderFieldValue(response, "Buffer-Height" as CFString, "\(height)" as CFString)
        CFHTTPMessageSetHeaderFieldValue(response, "Buffer-Orientation" as CFString, "\(orientation)" as CFString)
        CFHTTPMessageSetBody(response, jpegData as CFData)

        guard
            let serialized = CFHTTPMessageCopySerializedMessage(response)?.takeRetainedValue() as Data?
        else { return }

        if !connection.write(serialized) {
            // The main app closed its end (call ended, or the user hit our
            // in-app "stop sharing" button) — nothing more to send, and
            // finishing here is what makes ReplayKit clear the system's
            // "Beacon is broadcasting" status bar/indicator promptly instead
            // of leaving it running with nowhere for frames to go.
            finishBroadcastWithError(
                NSError(
                    domain: "com.beaconchat.app.BeaconScreenShare",
                    code: 3,
                    userInfo: [NSLocalizedDescriptionKey: "Beacon call ended."]
                )
            )
        }
    }
}

/// Client side of the Unix domain socket react-native-webrtc's
/// SocketConnection (main app process) binds and listens on as the server —
/// see this file's top-of-file comment. Deliberately minimal: this extension
/// only ever writes frames, so unlike the app's SocketConnection there's no
/// input stream/delegate handling here, just connect + write + close.
private final class ExtensionSocketConnection {
    private let filePath: String
    private var fileDescriptor: Int32 = -1
    private var outputStream: OutputStream?
    private(set) var isOpen = false

    init(filePath: String) {
        self.filePath = filePath
    }

    func openWithRetry(attempts: Int = 10, delaySeconds: Double = 0.3) -> Bool {
        for attempt in 1...attempts {
            if open() { return true }
            if attempt < attempts { Thread.sleep(forTimeInterval: delaySeconds) }
        }
        return false
    }

    private func open() -> Bool {
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)

        let pathBytes = Array(filePath.utf8)
        guard pathBytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { return false }
        withUnsafeMutableBytes(of: &addr.sun_path) { rawPtr in
            let dst = rawPtr.bindMemory(to: UInt8.self)
            for (i, byte) in pathBytes.enumerated() { dst[i] = byte }
            dst[pathBytes.count] = 0
        }

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }

        let connectResult = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
                connect(fd, sockaddrPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connectResult == 0 else {
            Darwin.close(fd)
            return false
        }

        var readStreamRef: Unmanaged<CFReadStream>?
        var writeStreamRef: Unmanaged<CFWriteStream>?
        CFStreamCreatePairWithSocket(kCFAllocatorDefault, fd, &readStreamRef, &writeStreamRef)
        // Balance the pair's retain so the unused read side is released
        // rather than leaked — this extension never reads from the socket.
        readStreamRef?.takeRetainedValue()

        guard let write = writeStreamRef?.takeRetainedValue() else {
            Darwin.close(fd)
            return false
        }
        CFWriteStreamSetProperty(write, CFStreamPropertyKey(rawValue: kCFStreamPropertyShouldCloseNativeSocket), kCFBooleanTrue)

        let stream = write as OutputStream
        stream.schedule(in: .current, forMode: .common)
        stream.open()

        fileDescriptor = fd
        outputStream = stream
        isOpen = true
        return true
    }

    @discardableResult
    func write(_ data: Data) -> Bool {
        guard isOpen, let stream = outputStream else { return false }
        return data.withUnsafeBytes { (rawBuffer: UnsafeRawBufferPointer) -> Bool in
            guard let base = rawBuffer.bindMemory(to: UInt8.self).baseAddress else { return false }
            var totalWritten = 0
            while totalWritten < data.count {
                let written = stream.write(base + totalWritten, maxLength: data.count - totalWritten)
                if written <= 0 { return false }
                totalWritten += written
            }
            return true
        }
    }

    func close() {
        outputStream?.close()
        outputStream = nil
        isOpen = false
        fileDescriptor = -1
    }
}
