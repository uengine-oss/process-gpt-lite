package org.uengine.pgptpro

import android.content.Context

/** Which pgpt pro server this app opens, and the basic-auth pair in front of it (if any). */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("pgpt-pro", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = sp.getString("server_url", "") ?: ""
        set(v) = sp.edit().putString("server_url", v).apply()

    var authUser: String
        get() = sp.getString("auth_user", "") ?: ""
        set(v) = sp.edit().putString("auth_user", v).apply()

    var authPass: String
        get() = sp.getString("auth_pass", "") ?: ""
        set(v) = sp.edit().putString("auth_pass", v).apply()

    companion object {
        /** "pgpt.example.com" → "https://pgpt.example.com"; trailing slashes dropped. */
        fun normalize(raw: String): String {
            var u = raw.trim().trimEnd('/')
            if (u.isNotEmpty() && !u.startsWith("http://") && !u.startsWith("https://")) u = "https://$u"
            return u
        }
    }
}
