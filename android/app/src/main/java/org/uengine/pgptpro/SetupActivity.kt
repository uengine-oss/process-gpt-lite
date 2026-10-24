package org.uengine.pgptpro

import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import java.net.HttpURLConnection
import java.net.URL
import java.util.Base64
import kotlin.concurrent.thread

/**
 * First run (and "서버 주소 바꾸기"): which server to open. The basic-auth pair is only for a server
 * published behind one (a tunnel's gate); signing in to pgpt pro itself happens in the web app.
 */
class SetupActivity : AppCompatActivity() {
    private lateinit var url: EditText
    private lateinit var user: EditText
    private lateinit var pass: EditText
    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = Prefs(this)
        val dp = resources.displayMetrics.density
        fun px(v: Int) = (v * dp).toInt()
        fun field(hint: String, value: String, type: Int) = EditText(this).apply {
            this.hint = hint; setText(value); inputType = type; textSize = 16f
            setPadding(px(16), px(14), px(16), px(14))
            background = GradientDrawable().apply { cornerRadius = px(14).toFloat(); setColor(Color.WHITE); setStroke(px(1), Color.parseColor("#D6D6D0")) }
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = px(10) }
        }

        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(px(24), px(56), px(24), px(24)) }
        col.addView(TextView(this).apply { text = "pgpt pro"; textSize = 30f; setTypeface(typeface, Typeface.BOLD); setTextColor(Color.parseColor("#1D1D1B")) })
        col.addView(TextView(this).apply {
            text = "사용할 서버 주소를 넣어 주세요. 회사 서버, 또는 공개 주소(Cloudflare·ngrok)를 쓸 수 있어요."
            textSize = 15f; setTextColor(Color.parseColor("#5C5B55")); setPadding(0, px(8), 0, px(12))
        })
        url = field("https://pgpt.example.com", prefs.serverUrl, InputType.TYPE_TEXT_VARIATION_URI)
        col.addView(url)
        col.addView(TextView(this).apply {
            text = "공개 주소에 접근 암호가 걸려 있으면 (선택)"; textSize = 13f; setTextColor(Color.parseColor("#8A897F")); setPadding(0, px(18), 0, 0)
        })
        user = field("아이디", prefs.authUser, InputType.TYPE_CLASS_TEXT)
        pass = field("암호", prefs.authPass, InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
        col.addView(user); col.addView(pass)
        status = TextView(this).apply { textSize = 14f; setPadding(0, px(14), 0, 0) }
        col.addView(status)
        col.addView(Button(this).apply {
            text = "연결"; textSize = 17f; isAllCaps = false; setTextColor(Color.WHITE)
            background = GradientDrawable().apply { cornerRadius = px(26).toFloat(); setColor(Color.parseColor("#1D1D1B")) }
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, px(52)).apply { topMargin = px(18) }
            setOnClickListener { check(prefs) }
        })
        setContentView(ScrollView(this).apply { setBackgroundColor(Color.parseColor("#F4F4F1")); addView(col) })
    }

    /** Reach the server once before saving, so a typo shows here and not as a blank page. */
    private fun check(prefs: Prefs) {
        val target = Prefs.normalize(url.text.toString())
        if (target.isEmpty()) { status.text = "주소를 넣어 주세요."; return }
        status.setTextColor(Color.parseColor("#5C5B55")); status.text = "연결 확인 중…"
        val u = user.text.toString().trim(); val p = pass.text.toString()
        thread {
            val result = try {
                val c = URL("$target/").openConnection() as HttpURLConnection
                c.connectTimeout = 8000; c.readTimeout = 8000; c.instanceFollowRedirects = true
                if (u.isNotEmpty()) c.setRequestProperty("Authorization", "Basic " + Base64.getEncoder().encodeToString("$u:$p".toByteArray()))
                c.responseCode
            } catch (e: Exception) { -1 }
            runOnUiThread {
                when {
                    result in 200..399 -> {
                        prefs.serverUrl = target; prefs.authUser = u; prefs.authPass = p
                        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK))
                        finish()
                    }
                    result == 401 -> { status.setTextColor(Color.parseColor("#C62828")); status.text = "접근 암호가 필요하거나 맞지 않아요." }
                    else -> { status.setTextColor(Color.parseColor("#C62828")); status.text = "서버에 연결하지 못했어요. 주소를 확인해 주세요." }
                }
            }
        }
    }
}
