import SwiftUI

/// แสดง grid ของ group nodes (หมวดหมู่, series, season, ฯลฯ)
struct GroupGridView: View {
    let groups: [PlaylistNode]
    let title: String
    let inheritedReferer: String?

    private let columns = [GridItem(.adaptive(minimum: 280), spacing: 48)]

    var body: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 48) {
                ForEach(Array(groups.enumerated()), id: \.offset) { _, group in
                    NavigationLink {
                        GroupDetailView(node: group, inheritedReferer: inheritedReferer)
                    } label: {
                        GroupCardView(node: group)
                    }
                    .buttonStyle(.card)
                }
            }
            .padding(.horizontal, 60)
            .padding(.vertical, 40)
        }
        .navigationTitle(title)
    }
}
