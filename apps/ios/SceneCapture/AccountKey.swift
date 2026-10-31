import Foundation

struct AccountDestination: Codable, Equatable {
    let server: String
    let database: String
    var maxUploadBytes: Int? = nil
    var pipelineAvailable: Bool? = nil
    var passwordLength: Int? = nil
    // Account support is independent of whether a reconstruction worker is advertised.
    var usesPortableAccountAPI: Bool { passwordLength == 6 || pipelineAvailable != nil }
}

struct HostedAccount: Decodable {
    let identity: String
    let displayName: String
    let provider: String
    let token: String?
    let personalKey: String
    let server: String
    let database: String
    var password: String? = nil

    func validatedKey(expected: AccountDestination) throws -> AccountKey {
        let key = try AccountKey.decode(personalKey, expected: expected)
        guard key.identity == identity.replacingOccurrences(of: "0x", with: "").lowercased(),
              (token == nil || key.token == token), server == expected.server, database == expected.database,
              provider == "key", !displayName.isEmpty,
              (password == nil || AccountKey.isPassword(password!)) else { throw AccountKey.KeyError.invalid }
        return key
    }
}

/// Same wire format as apps/web/src/account/key.ts. Decoding never authenticates a password.
struct AccountKey: Codable, Equatable {
    let server: String
    let database: String
    let identity: String
    let token: String

    static func isPassword(_ value: String) -> Bool {
        value.utf8.count == 6 && value.range(of: "^[0-9]{6}$", options: .regularExpression) != nil
    }
    static func signInBody(_ input: String, expected: AccountDestination) throws -> [String: String] {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if isPassword(value) { return ["password": value] }
        if value.hasPrefix("memos1.") { _ = try decode(value, expected: expected); return ["personalKey": value] }
        throw KeyError.password
    }

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
        case invalid, destination, password
        var errorDescription: String? {
            switch self {
            case .password: return "Enter exactly six digits."
            case .invalid: return "The saved account credential is incomplete or damaged. Sign in again with your six-digit password."
            case .destination: return "This password belongs to a different server or database. Check your server address."
            }
        }
    }
}
