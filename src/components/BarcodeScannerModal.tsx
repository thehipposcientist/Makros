import { View, Text, Modal, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';

interface Props {
  visible: boolean;
  onClose: () => void;
  onScan: (barcode: string) => void;
}

export default function BarcodeScannerModal({ visible, onClose, onScan }: Props) {
  const [scanned, setScanned] = useState(false);

  const handleScan = (data: string) => {
    if (scanned) return;
    setScanned(true);
    onScan(data);
    setTimeout(() => setScanned(false), 2000);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        {/* Camera */}
        {(() => {
          try {
            const { CameraView } = require('expo-camera');
            return (
              <CameraView
                style={StyleSheet.absoluteFillObject}
                facing="back"
                barcodeScannerSettings={{
                  barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39'],
                }}
                onBarcodeScanned={(result: any) => {
                  if (result?.data) handleScan(result.data);
                }}
              />
            );
          } catch {
            return (
              <View style={[StyleSheet.absoluteFillObject, { alignItems: 'center', justifyContent: 'center' }]}>
                <Ionicons name="camera-outline" size={48} color="#555" />
                <Text style={{ color: '#888', marginTop: 12, fontSize: 14 }}>Camera not available in Expo Go</Text>
                <Text style={{ color: '#666', marginTop: 4, fontSize: 12 }}>Use a development build to scan barcodes</Text>
              </View>
            );
          }
        })()}

        {/* Overlay */}
        <View style={styles.overlay}>
          {/* Top */}
          <View style={styles.topBar}>
            <Text style={styles.title}>Scan Barcode</Text>
            <Text style={styles.subtitle}>Point your camera at a product barcode</Text>
          </View>

          {/* Viewfinder */}
          <View style={styles.viewfinderContainer}>
            <View style={styles.viewfinder}>
              <View style={[styles.corner, styles.cornerTL]} />
              <View style={[styles.corner, styles.cornerTR]} />
              <View style={[styles.corner, styles.cornerBL]} />
              <View style={[styles.corner, styles.cornerBR]} />
            </View>
          </View>

          {/* Bottom */}
          <View style={styles.bottomBar}>
            {scanned && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                <ActivityIndicator color="#fff" size="small" />
                <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>Looking up product...</Text>
              </View>
            )}
            <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const CORNER_SIZE = 24;
const CORNER_WIDTH = 3;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  overlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'space-between' },
  topBar: { alignItems: 'center', paddingTop: 60, paddingBottom: 20, backgroundColor: 'rgba(0,0,0,0.6)' },
  title: { color: '#fff', fontSize: 18, fontWeight: '800' },
  subtitle: { color: 'rgba(255,255,255,0.7)', fontSize: 13, marginTop: 4 },
  viewfinderContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  viewfinder: { width: 260, height: 160, borderRadius: 12 },
  corner: { position: 'absolute', width: CORNER_SIZE, height: CORNER_SIZE },
  cornerTL: { top: 0, left: 0, borderTopWidth: CORNER_WIDTH, borderLeftWidth: CORNER_WIDTH, borderColor: '#fff', borderTopLeftRadius: 12 },
  cornerTR: { top: 0, right: 0, borderTopWidth: CORNER_WIDTH, borderRightWidth: CORNER_WIDTH, borderColor: '#fff', borderTopRightRadius: 12 },
  cornerBL: { bottom: 0, left: 0, borderBottomWidth: CORNER_WIDTH, borderLeftWidth: CORNER_WIDTH, borderColor: '#fff', borderBottomLeftRadius: 12 },
  cornerBR: { bottom: 0, right: 0, borderBottomWidth: CORNER_WIDTH, borderRightWidth: CORNER_WIDTH, borderColor: '#fff', borderBottomRightRadius: 12 },
  bottomBar: { alignItems: 'center', paddingBottom: 50, paddingTop: 20, backgroundColor: 'rgba(0,0,0,0.6)' },
  cancelBtn: { backgroundColor: 'rgba(255,255,255,0.2)', paddingHorizontal: 32, paddingVertical: 14, borderRadius: 14 },
  cancelText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
