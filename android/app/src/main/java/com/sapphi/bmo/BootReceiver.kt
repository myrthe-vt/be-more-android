package com.sapphi.bmo

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log


class BootReceiver : BroadcastReceiver() {

    companion object {
        private const val BOOT_LOG =
            "BMO_BOOT"
    }


    override fun onReceive(
        context: Context,
        intent: Intent
    ) {
        if (
            intent.action !=
            Intent.ACTION_BOOT_COMPLETED
        ) {
            return
        }

        Log.i(
            BOOT_LOG,
            "BOOT_COMPLETED received; starting BMO"
        )

        val launchIntent =
            Intent(
                context,
                MainActivity::class.java
            ).apply {
                addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                            Intent.FLAG_ACTIVITY_CLEAR_TOP or
                            Intent.FLAG_ACTIVITY_SINGLE_TOP
                )
            }

        try {
            context.startActivity(
                launchIntent
            )

        } catch (
            exception: Exception
        ) {
            Log.e(
                BOOT_LOG,
                "Could not start BMO after boot",
                exception
            )
        }
    }
}
