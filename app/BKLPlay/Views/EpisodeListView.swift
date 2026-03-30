import SwiftUI

struct EpisodeListView: View {
    let title: String
    let stations: [Station]
    let inheritedReferer: String?

    @State private var playerSelection: PlayerSelection? = nil

    private let columns = [GridItem(.adaptive(minimum: 400), spacing: 40)]

    var body: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 40) {
                ForEach(Array(stations.enumerated()), id: \.offset) { index, station in
                    Button {
                        playerSelection = PlayerSelection(index: index)
                    } label: {
                        EpisodeCardView(station: station)
                    }
                    .buttonStyle(.card)
                }
            }
            .padding(.horizontal, 60)
            .padding(.vertical, 40)
        }
        .navigationTitle(title)
        .fullScreenCover(item: $playerSelection) { selection in
            VideoPlayerView(
                stations: stations,
                startIndex: selection.index,
                inheritedReferer: inheritedReferer
            )
        }
    }
}

struct PlayerSelection: Identifiable {
    let id = UUID()
    let index: Int
}
