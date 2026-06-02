import Foundation
import Security

final class WatchCellularClient {
    static let shared = WatchCellularClient()

    private let tokenService = "com.thallo.watch.cellular"
    private let tokenAccount = "watch-api-token"
    private let apiBaseUrlKey = "thallo.watchCellular.apiBaseUrl"
    private let expiresAtKey = "thallo.watchCellular.expiresAt"
    private let userIdKey = "thallo.watchCellular.userId"
    private let supportedDirectCommands: Set<String> = ["log_hydration", "end_workout"]

    private init() {}

    func configure(from dict: [String: Any]) {
        if (dict["clear"] as? Bool) == true {
            clear()
            return
        }
        guard let apiBaseUrl = (dict["apiBaseUrl"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !apiBaseUrl.isEmpty,
              let accessToken = (dict["accessToken"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !accessToken.isEmpty
        else { return }

        UserDefaults.standard.set(apiBaseUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/")), forKey: apiBaseUrlKey)
        if let expiresAt = (dict["expiresAt"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !expiresAt.isEmpty {
            UserDefaults.standard.set(expiresAt, forKey: expiresAtKey)
        }
        if let userId = dict["userId"] {
            UserDefaults.standard.set(String(describing: userId), forKey: userIdKey)
        }
        saveToken(accessToken)
    }

    func clear() {
        UserDefaults.standard.removeObject(forKey: apiBaseUrlKey)
        UserDefaults.standard.removeObject(forKey: expiresAtKey)
        UserDefaults.standard.removeObject(forKey: userIdKey)
        deleteToken()
    }

    func canSendDirectCommand(_ command: String) -> Bool {
        supportedDirectCommands.contains(command) && hasUsableConfig
    }

    var hasUsableConfig: Bool {
        guard token() != nil,
              let apiBaseUrl = UserDefaults.standard.string(forKey: apiBaseUrlKey),
              !apiBaseUrl.isEmpty
        else { return false }
        guard let expiresAt = UserDefaults.standard.string(forKey: expiresAtKey),
              !expiresAt.isEmpty
        else { return true }
        if let expiry = ISO8601DateFormatter().date(from: expiresAt) {
            return expiry.timeIntervalSinceNow > 60
        }
        return true
    }

    func sendCommand(_ commandBody: [String: Any], completion: @escaping (Bool) -> Void) {
        guard let token = token(),
              let apiBaseUrl = UserDefaults.standard.string(forKey: apiBaseUrlKey),
              let url = URL(string: "\(apiBaseUrl)/watch/commands"),
              JSONSerialization.isValidJSONObject(commandBody),
              let data = try? JSONSerialization.data(withJSONObject: commandBody)
        else {
            completion(false)
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = data
        URLSession.shared.dataTask(with: request) { _, response, error in
            guard error == nil,
                  let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode)
            else {
                completion(false)
                return
            }
            completion(true)
        }.resume()
    }

    func fetchReadiness(completion: @escaping (WatchReadinessSnapshot?) -> Void) {
        guard let token = token(),
              let apiBaseUrl = UserDefaults.standard.string(forKey: apiBaseUrlKey),
              let url = URL(string: "\(apiBaseUrl)/watch/readiness")
        else {
            completion(nil)
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        URLSession.shared.dataTask(with: request) { data, response, error in
            guard error == nil,
                  let data,
                  let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode),
                  let decoded = Self.decodeReadinessSnapshot(from: data)
            else {
                completion(nil)
                return
            }
            completion(decoded)
        }.resume()
    }

    private static func decodeReadinessSnapshot(from data: Data) -> WatchReadinessSnapshot? {
        guard var dict = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return nil
        }
        if dict["syncedAtMs"] == nil {
            dict["syncedAtMs"] = dict["computed_at_ms"] ?? Int(Date().timeIntervalSince1970 * 1000)
        }
        let payload: [String: Any] = [
            "score": dict["score"] ?? NSNull(),
            "label": dict["label"] ?? NSNull(),
            "summary": dict["summary"] ?? NSNull(),
            "factors": dict["factors"] ?? [],
            "syncedAtMs": dict["syncedAtMs"] ?? 0,
        ]
        guard JSONSerialization.isValidJSONObject(payload),
              let normalized = try? JSONSerialization.data(withJSONObject: payload)
        else { return nil }
        return try? JSONDecoder().decode(WatchReadinessSnapshot.self, from: normalized)
    }

    private func token() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: tokenService,
            kSecAttrAccount as String: tokenAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func saveToken(_ token: String) {
        deleteToken()
        guard let data = token.data(using: .utf8) else { return }
        let attrs: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: tokenService,
            kSecAttrAccount as String: tokenAccount,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: data,
        ]
        SecItemAdd(attrs as CFDictionary, nil)
    }

    private func deleteToken() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: tokenService,
            kSecAttrAccount as String: tokenAccount,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
