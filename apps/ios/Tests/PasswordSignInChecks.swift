import Foundation

// Exercise the actual phone sign-in and copy actions, with isolated Keychain/preferences.
// No person's app state, clipboard, recordings, or credentials are read or changed.
final class PasswordTestStore: CaptureIdentityStore {
    var value: ServerIdentity?
    func read(_ endpoint: String) -> ServerIdentity? { value }
    func save(_ identity: ServerIdentity, for endpoint: String) throws { value = identity }
}

@main struct PasswordSignInChecks {
    @MainActor static func main() async throws {
        let args = CommandLine.arguments
        func option(_ name: String) -> String? {
            guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
            return args[i + 1]
        }
        guard let origin = option("--api"), let accountPath = option("--account-file"),
              let url = URL(string: origin), let host = url.host,
              ["http", "https"].contains(url.scheme ?? ""),
              ["localhost", "127.0.0.1"].contains(host) || args.contains("--live") else {
            throw CaptureFailure.message("Use --api ORIGIN --account-file SYNTHETIC_TEST_ACCOUNT_JSON [--live]")
        }
        struct Fixture: Decodable { let account: HostedAccount }
        let account = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: accountPath))).account
        let store = PasswordTestStore()
        store.value = ServerIdentity(identity: account.identity, token: account.token!, personalKey: account.personalKey)
        let suite = "memos.password-test." + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(suite)
        defer { defaults.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: directory) }
        defaults.set(origin, forKey: "memreplay.endpoint")
        let library = SceneLibrary(directory: directory, defaults: defaults, identities: store)
        await library.refresh()
        guard library.profileReady else { throw CaptureFailure.message("Initial profile: " + library.profileMessage) }
        let memories = library.scenes.map(\.id).sorted()

        // Simulates pasting a website password after the app cached older API capabilities.
        library.personalKeyInput = " \n" + account.password! + "\n "
        await library.importAccount()
        if args.contains("--unsupported") {
            guard library.profileMessage.contains("six-digit"), !library.profileMessage.contains("memos1"),
                  store.value?.password == nil, library.userID == account.identity else {
                throw CaptureFailure.message("Unsupported server must explain the upgrade and preserve the account: " + library.profileMessage)
            }
            print("PASS unsupported API explains six-digit support; existing phone account preserved")
            return
        }
        guard store.value?.password == account.password, library.personalKeyInput.isEmpty,
              library.profileReady, library.userID == account.identity, library.displayName == account.displayName else {
            throw CaptureFailure.message("Numeric sign-in failed: " + library.profileMessage)
        }
        // Wait for the sign-in action's automatic refresh before testing Copy password.
        for _ in 0..<300 {
            if library.scenes.map(\.id).sorted() == memories && !library.checking { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        guard library.scenes.map(\.id).sorted() == memories else { throw CaptureFailure.message("Memories changed during sign-in") }
        await library.copyPersonalKey()
        guard library.profileMessage.contains("Password copied"), let copied = store.value?.password,
              AccountKey.isPassword(copied) else { throw CaptureFailure.message("Copy password failed: " + library.profileMessage) }

        let secondStore = PasswordTestStore()
        let second = SceneLibrary(directory: directory.appendingPathComponent("second-phone"), defaults: defaults, identities: secondStore)
        second.personalKeyInput = copied
        await second.importAccount()
        guard second.profileReady, second.userID == account.identity, second.displayName == account.displayName,
              secondStore.value?.password == copied else { throw CaptureFailure.message("Copied password sign-in failed: " + second.profileMessage) }
        print("PASS native paste → password API → verified profile; leading zeros and outer whitespace preserved")
        print("PASS native Copy password value → fresh phone session → same identity and name")
        print("PASS original account memories preserved; test uses isolated credential stores")
    }
}
