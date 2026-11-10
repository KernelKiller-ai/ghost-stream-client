/*
 * GHOST-STREAM // GhostRadarPlugin.kt
 * Capacitor plugin: background BLE + Wi-Fi Direct peer discovery and
 * pinless 1-tap Wi-Fi Direct sockets.
 *
 * Deploy at: android/app/src/main/java/com/ghoststream/tactical/GhostRadarPlugin.kt
 * (adjust the package line below if your applicationId differs)
 *
 * Manifest prerequisites (already in AndroidManifest.permissions.xml):
 *   BLUETOOTH_SCAN (neverForLocation), BLUETOOTH_CONNECT, BLUETOOTH_ADVERTISE
 *   ACCESS_FINE_LOCATION, CHANGE_WIFI_STATE, ACCESS_WIFI_STATE,
 *   CHANGE_WIFI_MULTICAST_STATE, NEARBY_WIFI_DEVICES
 *
 * Runtime permissions are requested via Capacitor's built-in flow:
 * this plugin implements @CapacitorPlugin(permission=...) annotations.
 */

package com.ghoststream.tactical

import android.Manifest
import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.wifi.WpsInfo
import android.net.wifi.p2p.WifiP2pConfig
import android.net.wifi.p2p.WifiP2pDevice
import android.net.wifi.p2p.WifiP2pInfo
import android.net.wifi.p2p.WifiP2pManager
import android.os.Build
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.io.IOException
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * Service advertisement hash — MUST equal GS_SERVICE_HASH in nativeRadar.js.
 * 0x1B2A = FNV-1a("ghost-stream-radar-v1") truncated to 16 bits.
 */
const val GS_SERVICE_HASH: Int = 0x1B2A
private const val TAG = "GhostRadar"

@CapacitorPlugin(
    name = "GhostRadar",
    permissions = [
        Permission(strings = [Manifest.permission.BLUETOOTH_SCAN], alias = "ble"),
        Permission(strings = [Manifest.permission.ACCESS_FINE_LOCATION], alias = "location")
    ]
)
class GhostRadarPlugin : Plugin() {

    // ---------------- BLE ----------------

    private val bluetoothAdapter: android.bluetooth.BluetoothAdapter? by lazy {
        val bm = context.getSystemService(Context.BLUETOOTH_SERVICE) as android.bluetooth.BluetoothManager
        bm.adapter
    }

    private var bleScanner: android.bluetooth.le.BluetoothLeScanner? = null

    /** serviceUuid = 0000<<hash>>-0000-1000-8000-00805f9b34fb */
    private fun serviceUuid(hash: Int): java.util.UUID =
        java.util.UUID.fromString("0000%04x-0000-1000-8000-00805f9b34fb".format(hash))

    private var scanFilter: android.bluetooth.le.ScanFilter? = null
    private var scanSettings: android.bluetooth.le.ScanSettings? = null

    private val scanCallback = object : android.bluetooth.le.ScanCallback() {
        override fun onScanResult(callbackType: Int, result: android.bluetooth.le.ScanResult) {
            val p = JSObject()
            p.put("deviceId", result.device.address)
            p.put("name", result.device.name ?: "GS-PEER")
            p.put("rssi", result.rssi)
            p.put("transport", "ble")
            notifyListeners("peerFound", p)
        }
        override fun onScanFailed(errorCode: Int) {
            Log.w(TAG, "BLE scan failed: $errorCode")
        }
    }

    // ---------------- Wi-Fi Direct ----------------

    private val p2pManager: WifiP2pManager? by lazy {
        context.getSystemService(Context.WIFI_P2P_SERVICE) as? WifiP2pManager
    }
    private val p2pChannel: WifiP2pManager.Channel? by lazy {
        p2pManager?.initialize(context, context.mainLooper, null)
    }

    private var p2pReceiverRegistered = false
    private var p2pDnsSdListenerAttached = false

    private val p2pReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            when (intent.action) {
                WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION -> requestP2pPeers()
                WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION -> handleP2pConnection(intent)
            }
        }
    }

    private fun requestP2pPeers() {
        val mgr = p2pManager ?: return
        val ch = p2pChannel ?: return
        mgr.discoverPeers(ch, object : WifiP2pManager.ActionListener {
            override fun onSuccess() {}
            override fun onFailure(reason: Int) {
                Log.w(TAG, "discoverPeers failed: $reason")
            }
        })
    }

    private fun handleP2pConnection(intent: Intent) {
        // Group info arrives with the CONNECTION_CHANGED broadcast.
        val info = intent.getParcelableExtra<WifiP2pInfo>(WifiP2pManager.EXTRA_WIFI_P2P_INFO) ?: return
        if (info.groupFormed && info.groupOwnerAddress != null) {
            // Auto-accept, pinless: the group was negotiated without WPS PIN.
            val addr = info.groupOwnerAddress.hostAddress ?: return
            val evt = JSObject()
            evt.put("deviceId", addr)
            evt.put("groupOwner", info.isGroupOwner)
            notifyListeners("wifiDirectReady", evt)
        }
    }

    // ---------------- Plugin methods ----------------

    @PluginMethod
    fun startDiscovery(call: PluginCall) {
        val hash = call.getInt("serviceHash", GS_SERVICE_HASH) ?: GS_SERVICE_HASH
        val sessionId = UUID.randomUUID().toString()

        // ---- BLE path ----
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (getPermissionState("ble") != PermissionState.GRANTED) {
                requestPermissionForAlias("ble", call, "blePermissionCallback")
                return
            }
        } else {
            if (getPermissionState("location") != PermissionState.GRANTED) {
                requestPermissionForAlias("location", call, "locPermissionCallback")
                return
            }
        }
        startBleScan(hash)

        // ---- Wi-Fi Direct path ----
        startWifiDirectDiscovery()

        val ret = JSObject()
        ret.put("sessionId", sessionId)
        call.resolve(ret)
    }

    private fun startBleScan(hash: Int) {
        val adapter = bluetoothAdapter ?: return
        if (!adapter.isEnabled) return
        bleScanner = adapter.bluetoothLeScanner ?: return

        scanFilter = android.bluetooth.le.ScanFilter.Builder()
            .setServiceUuid(android.os.ParcelUuid(serviceUuid(hash)))
            .build()
        scanSettings = android.bluetooth.le.ScanSettings.Builder()
            .setScanMode(android.bluetooth.le.ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()

        try {
            bleScanner?.startScan(listOfNotNull(scanFilter), scanSettings, scanCallback)
            Log.i(TAG, "BLE scan started (hash=0x%04x)".format(hash))
        } catch (e: SecurityException) {
            Log.w(TAG, "BLE scan permission missing: ${e.message}")
        }
    }

    private fun startWifiDirectDiscovery() {
        val mgr = p2pManager ?: return
        val ch = p2pChannel ?: return

        if (!p2pReceiverRegistered) {
            val filter = IntentFilter().apply {
                addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION)
                addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION)
            }
            context.registerReceiver(p2pReceiver, filter)
            p2pReceiverRegistered = true
        }

        if (!p2pDnsSdListenerAttached) {
            mgr.setDnsSdResponseListeners(
                ch,
                { instanceName, _, device ->
                    // Service instance "gs-<hash>-<deviceId>" matches ours
                    if (instanceName.startsWith("gs-$GS_SERVICE_HASH")) {
                        val p = JSObject()
                        p.put("deviceId", device.deviceAddress)
                        p.put("name", device.deviceName ?: instanceName)
                        p.put("rssi", null) // P2P doesn't expose RSSI here
                        p.put("transport", "wifi-p2p")
                        notifyListeners("peerFound", p)
                    }
                },
                { _, _, _ -> } // TXT record listener unused
            )
            mgr.addServiceRequest(ch, WifiP2pManager.DnsSdServiceRequest.newInstance(P2P_SERVICE_TYPE, null),
                object : WifiP2pManager.ActionListener {
                    override fun onSuccess() {
                        mgr.discoverServices(ch, object : WifiP2pManager.ActionListener {
                            override fun onSuccess() {}
                            override fun onFailure(reason: Int) { Log.w(TAG, "discoverServices: $reason") }
                        })
                    }
                    override fun onFailure(reason: Int) { Log.w(TAG, "addServiceRequest: $reason") }
                })
            p2pDnsSdListenerAttached = true
        }

        mgr.discoverPeers(ch, object : WifiP2pManager.ActionListener {
            override fun onSuccess() {}
            override fun onFailure(reason: Int) { Log.w(TAG, "discoverPeers: $reason") }
        })
    }

    companion object {
        private const val P2P_SERVICE_TYPE = "_ghost-stream._tcp"
    }

    @PluginMethod
    fun stopDiscovery(call: PluginCall) {
        try {
            bleScanner?.stopScan(scanCallback)
        } catch (e: SecurityException) { /* scanner already dead */ }
        bleScanner = null

        if (p2pReceiverRegistered) {
            try {
                context.unregisterReceiver(p2pReceiver)
            } catch (_: Exception) {}
            p2pReceiverRegistered = false
        }
        p2pManager?.stopPeerDiscovery(p2pChannel, null)
        call.resolve()
    }

    @PermissionCallback
    private fun blePermissionCallback(call: PluginCall) {
        if (getPermissionState("ble") == PermissionState.GRANTED) {
            startBleScan(GS_SERVICE_HASH)
            startWifiDirectDiscovery()
            val ret = JSObject()
            ret.put("sessionId", UUID.randomUUID().toString())
            call.resolve(ret)
        } else {
            call.reject("BLUETOOTH_PERMISSION_DENIED")
        }
    }

    @PermissionCallback
    private fun locPermissionCallback(call: PluginCall) {
        if (getPermissionState("location") == PermissionState.GRANTED) {
            startBleScan(GS_SERVICE_HASH)
            startWifiDirectDiscovery()
            val ret = JSObject()
            ret.put("sessionId", UUID.randomUUID().toString())
            call.resolve(ret)
        } else {
            call.reject("LOCATION_PERMISSION_DENIED")
        }
    }

    // ---------------- 1-tap pinless connect ----------------

    private val executor = Executors.newCachedThreadPool()
    private val sockets = ConcurrentHashMap<String, Socket>()

    @SuppressLint("MissingPermission") // BLUETOOTH_CONNECT checked at call site
    @PluginMethod
    fun connect(call: PluginCall) {
        val deviceId = call.getString("deviceId") ?: return call.reject("NRAD_NO_DEVICE")
        val mgr = p2pManager ?: return call.reject("NRAD_NO_P2P")
        val ch = p2pChannel ?: return call.reject("NRAD_NO_P2P")

        // Auto-accept WPA2-less P2P group formation — no PIN, no system dialog.
        val config = WifiP2pConfig().apply {
            deviceAddress = deviceId
            wps.setup = WpsInfo.PBC // push-button: intent-based auto pairing
            groupOwnerIntent = 0     // prefer to be a group CLIENT (join quickly)
        }

        mgr.connect(ch, config, object : WifiP2pManager.ActionListener {
            override fun onSuccess() { /* group negotiation continues asynchronously */ }
            override fun onFailure(reason: Int) {
                val evt = JSObject()
                evt.put("deviceId", deviceId)
                evt.put("error", "P2P_CONNECT_FAILED_$reason")
                notifyListeners("connectResult", evt)
                call.reject("NRAD_P2P_CONNECT_FAILED")
            }
        })

        // After the group forms, the client connects to the owner's socket.
        // The owner binds a ServerSocket on GS_PORT (10000) in parallel.
        executor.submit {
            try {
                // Give group formation a bounded settle window.
                Thread.sleep(1500)
                val socket = Socket()
                socket.connect(InetSocketAddress(deviceId, 10000), 8000)
                val socketId = UUID.randomUUID().toString()
                sockets[socketId] = socket
                val evt = JSObject()
                evt.put("deviceId", deviceId)
                evt.put("socketId", socketId)
                evt.put("port", 10000)
                notifyListeners("connectResult", evt)
                call.resolve(JSObject().apply {
                    put("socketId", socketId)
                    put("port", 10000)
                })
            } catch (e: IOException) {
                call.reject("NRAD_SOCKET_FAILED: ${e.message}")
            }
        }
    }

    /** Owner side: bind a ServerSocket so peers can 1-tap into us. */
    fun startOwnerListener(port: Int = 10000) {
        executor.submit {
            val server = ServerSocket()
            server.reuseAddress = true
            server.bind(InetSocketAddress(port))
            while (!server.isClosed) {
                val s = try { server.accept() } catch (e: IOException) { break }
                val socketId = UUID.randomUUID().toString()
                sockets[socketId] = s
                val evt = JSObject()
                evt.put("deviceId", s.inetAddress?.hostAddress ?: "unknown")
                evt.put("socketId", socketId)
                evt.put("port", port)
                notifyListeners("connectResult", evt)
            }
        }
    }

    override fun handleOnDestroy() {
        try {
            bleScanner?.stopScan(scanCallback)
        } catch (_: Exception) {}
        if (p2pReceiverRegistered) {
            try { context.unregisterReceiver(p2pReceiver) } catch (_: Exception) {}
        }
        sockets.values.forEach { try { it.close() } catch (_: IOException) {} }
        executor.shutdownNow()
        super.handleOnDestroy()
    }
}
