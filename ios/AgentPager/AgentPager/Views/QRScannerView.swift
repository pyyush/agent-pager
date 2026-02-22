import SwiftUI
import AVFoundation

/// UIViewRepresentable wrapping AVCaptureSession for QR code scanning.
struct QRScannerView: UIViewRepresentable {
    let onCodeScanned: (String) -> Void

    func makeUIView(context: Context) -> QRScannerUIView {
        let view = QRScannerUIView()
        view.onCodeScanned = onCodeScanned
        return view
    }

    func updateUIView(_ uiView: QRScannerUIView, context: Context) {}

    class QRScannerUIView: UIView, AVCaptureMetadataOutputObjectsDelegate {
        var onCodeScanned: ((String) -> Void)?
        private var captureSession: AVCaptureSession?
        private var previewLayer: AVCaptureVideoPreviewLayer?
        private var hasScanned = false

        override func layoutSubviews() {
            super.layoutSubviews()
            previewLayer?.frame = bounds

            if captureSession == nil {
                setupCamera()
            }
        }

        private func setupCamera() {
            let session = AVCaptureSession()
            captureSession = session

            guard let device = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device) else {
                return
            }

            if session.canAddInput(input) {
                session.addInput(input)
            }

            let output = AVCaptureMetadataOutput()
            if session.canAddOutput(output) {
                session.addOutput(output)
                output.setMetadataObjectsDelegate(self, queue: .main)
                output.metadataObjectTypes = [.qr]
            }

            let preview = AVCaptureVideoPreviewLayer(session: session)
            preview.videoGravity = .resizeAspectFill
            preview.frame = bounds
            layer.addSublayer(preview)
            previewLayer = preview

            DispatchQueue.global(qos: .userInitiated).async {
                session.startRunning()
            }
        }

        func metadataOutput(
            _ output: AVCaptureMetadataOutput,
            didOutput metadataObjects: [AVMetadataObject],
            from connection: AVCaptureConnection
        ) {
            guard !hasScanned,
                  let metadata = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
                  let code = metadata.stringValue else {
                return
            }

            hasScanned = true
            captureSession?.stopRunning()

            // Haptic feedback
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()

            onCodeScanned?(code)
        }

        func resetScanner() {
            hasScanned = false
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                self?.captureSession?.startRunning()
            }
        }
    }
}

// MARK: - Previews

#if DEBUG
#Preview {
    // Camera requires a real device — shows blank in Simulator/Canvas
    QRScannerView { code in
        print("Scanned: \(code)")
    }
}
#endif
