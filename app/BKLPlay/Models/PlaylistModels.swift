import Foundation

struct PlaylistNode: Codable {
    let url: String?
    let name: String?
    let author: String?
    let image: String?
    let imageScale: String?
    let info: String?
    let referer: String?
    let groups: [PlaylistNode]?
    let stations: [Station]?

    /// ต้อง fetch จาก url เมื่อ node มี url แต่ยังไม่มี groups/stations
    var needsFetch: Bool {
        url != nil && groups == nil && stations == nil
    }

    var displayName: String {
        name ?? info ?? "Unknown"
    }
}

struct Station: Codable {
    let name: String?
    let image: String?
    let url: String
    let referer: String?
}
