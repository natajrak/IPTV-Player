import SwiftUI
import AVKit

struct VideoPlayerView: View {
    let stations: [Station]
    let startIndex: Int
    let inheritedReferer: String?

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        PlayerRepresentable(
            stations: stations,
            startIndex: startIndex,
            inheritedReferer: inheritedReferer,
            onFinished: { dismiss() }
        )
        .ignoresSafeArea()
    }
}

// MARK: - UIViewControllerRepresentable

struct PlayerRepresentable: UIViewControllerRepresentable {
    let stations: [Station]
    let startIndex: Int
    let inheritedReferer: String?
    let onFinished: () -> Void

    func makeCoordinator() -> PlayerCoordinator {
        PlayerCoordinator(onFinished: onFinished)
    }

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let vc = AVPlayerViewController()
        context.coordinator.configure(
            vc: vc,
            stations: stations,
            startIndex: startIndex,
            inheritedReferer: inheritedReferer
        )
        return vc
    }

    func updateUIViewController(_ uiViewController: AVPlayerViewController, context: Context) {}
}

// MARK: - Coordinator (ควบคุม auto-play next)

final class PlayerCoordinator: NSObject {
    private let onFinished: () -> Void

    init(onFinished: @escaping () -> Void) {
        self.onFinished = onFinished
    }

    func configure(
        vc: AVPlayerViewController,
        stations: [Station],
        startIndex: Int,
        inheritedReferer: String?
    ) {
        // สร้าง AVPlayerItem สำหรับทุก episode ตั้งแต่ที่เลือกเป็นต้นไป
        let items: [AVPlayerItem] = stations[startIndex...].compactMap { station in
            guard let url = URL(string: station.url) else { return nil }
            let referer = station.referer ?? inheritedReferer
            var options: [String: Any]? = nil
            if let referer {
                options = ["AVURLAssetHTTPHeaderFieldsKey": ["Referer": referer]]
            }
            let asset = AVURLAsset(url: url, options: options)
            return AVPlayerItem(asset: asset)
        }

        guard !items.isEmpty else {
            onFinished()
            return
        }

        // AVQueuePlayer เล่นต่อเนื่องอัตโนมัติโดยไม่ต้องจัดการเอง
        let player = AVQueuePlayer(items: items)
        vc.player = player

        // รับ notification เมื่อ episode สุดท้ายจบ → dismiss player
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(lastItemDidFinish),
            name: .AVPlayerItemDidPlayToEndTime,
            object: items.last
        )

        player.play()
    }

    @objc private func lastItemDidFinish() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.onFinished()
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }
}
