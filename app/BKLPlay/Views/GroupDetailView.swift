import SwiftUI

/// Resolver: ถ้า node ยังไม่มีข้อมูล → fetch แล้วแสดงผล
/// ถ้ามี groups → GroupGridView
/// ถ้ามี stations → EpisodeListView
struct GroupDetailView: View {
    let node: PlaylistNode
    let inheritedReferer: String?

    @State private var resolved: PlaylistNode?
    @State private var isLoading = false
    @State private var errorMessage: String?

    private var displayNode: PlaylistNode { resolved ?? node }
    private var effectiveReferer: String? { displayNode.referer ?? inheritedReferer }

    var body: some View {
        Group {
            if isLoading {
                ProgressView()
                    .scaleEffect(2)
            } else if let errorMessage {
                VStack(spacing: 20) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 60))
                        .foregroundStyle(.yellow)
                    Text(errorMessage)
                        .foregroundStyle(.secondary)
                }
            } else if let groups = displayNode.groups {
                GroupGridView(
                    groups: groups,
                    title: displayNode.displayName,
                    inheritedReferer: effectiveReferer
                )
            } else if let stations = displayNode.stations {
                EpisodeListView(
                    title: displayNode.displayName,
                    stations: stations,
                    inheritedReferer: effectiveReferer
                )
            }
        }
        .task {
            guard node.needsFetch, let url = node.url else { return }
            isLoading = true
            do {
                resolved = try await PlaylistService.shared.fetch(url)
            } catch {
                errorMessage = error.localizedDescription
            }
            isLoading = false
        }
    }
}
