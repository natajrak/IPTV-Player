import SwiftUI

/// Card แสดง poster ของ series/season/หมวดหมู่ (แนวตั้ง 2:3)
struct GroupCardView: View {
    let node: PlaylistNode

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            AsyncImage(url: URL(string: node.image ?? "")) { phase in
                switch phase {
                case .success(let image):
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                case .failure:
                    placeholder
                case .empty:
                    placeholder
                        .overlay(ProgressView())
                @unknown default:
                    placeholder
                }
            }
            .frame(width: 280, height: 420)
            .clipShape(RoundedRectangle(cornerRadius: 12))

            Text(node.displayName)
                .font(.headline)
                .foregroundStyle(.primary)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
                .frame(width: 280, alignment: .leading)
        }
    }

    private var placeholder: some View {
        RoundedRectangle(cornerRadius: 12)
            .fill(Color.gray.opacity(0.3))
            .overlay(
                Image(systemName: "film")
                    .font(.system(size: 40))
                    .foregroundStyle(.secondary)
            )
    }
}
