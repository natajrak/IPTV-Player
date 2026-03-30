import SwiftUI

struct ContentView: View {
    @State private var rootNode: PlaylistNode?
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    VStack(spacing: 24) {
                        ProgressView()
                            .scaleEffect(2)
                        Text("กำลังโหลด...")
                            .font(.title3)
                            .foregroundStyle(.secondary)
                    }
                } else if let errorMessage {
                    VStack(spacing: 20) {
                        Image(systemName: "wifi.exclamationmark")
                            .font(.system(size: 60))
                            .foregroundStyle(.red)
                        Text("โหลดไม่สำเร็จ")
                            .font(.title2)
                        Text(errorMessage)
                            .foregroundStyle(.secondary)
                    }
                } else if let groups = rootNode?.groups {
                    GroupGridView(groups: groups, title: "BKLPlay", inheritedReferer: nil)
                }
            }
        }
        .task {
            do {
                rootNode = try await PlaylistService.shared.fetch(PlaylistService.shared.mainPlaylistURL)
            } catch {
                errorMessage = error.localizedDescription
            }
            isLoading = false
        }
    }
}
