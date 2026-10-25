import Foundation

struct AccountDestination: Codable, Equatable {
    let server: String
    let database: String
    var maxUploadBytes: Int? = nil
    var pipelineAvailable: Bool? = nil
    var usesPortableAccountAPI: Bool { pipelineAvailable != nil }
}

struct HostedAccount: Decodable {
    let identity: String
    let displayName: String
    let provider: String
    let token: String?
    let personalKey: String
    let server: String
    let database: String

    func validatedKey(expected: AccountDestination) throws -> AccountKey {
        let key = try AccountKey.decode(personalKey, expected: expected)
        guard key.identity == identity.replacingOccurrences(of: "0x", with: "").lowercased(),
              (token == nil || key.token == token), server == expected.server, database == expected.database,
              provider == "key", !displayName.isEmpty else { throw AccountKey.KeyError.invalid }
        return key
    }
}

/// Same wire format as apps/web/src/account-key.ts. Decoding never authenticates a key.
struct AccountKey: Codable, Equatable {
    let server: String
    let database: String
    let identity: String
    let token: String

    func encoded() throws -> String {
        "memos1." + (try JSONEncoder().encode(self)).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func decode(_ input: String, expected: AccountDestination) throws -> AccountKey {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.hasPrefix("memos1."), value.utf8.count <= 16384 else { throw KeyError.invalid }
        let payload = String(value.dropFirst(7))
        guard payload.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { throw KeyError.invalid }
        var base64 = payload.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let bytes = Data(base64Encoded: base64), let key = try? JSONDecoder().decode(Self.self, from: bytes),
              key.identity.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              key.token.utf8.count <= 8192,
              key.token.range(of: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { throw KeyError.invalid }
        guard key.server == expected.server, key.database == expected.database else { throw KeyError.destination }
        return key
    }
    enum KeyError: LocalizedError {
        case invalid, destination
        var errorDescription: String? {
            switch self {
            case .invalid: return "Paste the complete personal key starting with memos1. A party code is different."
            case .destination: return "This key belongs to a different server or database. Check your server address."
            }
        }
    }
}
