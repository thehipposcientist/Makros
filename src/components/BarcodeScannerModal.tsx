import { View, Text, Modal, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRef, useEffect } from 'react';
import ScanReticle from './ScanReticle';

interface Props {
  visible: boolean;
  onClose: () => void;
  onScan: (barcode: string) => void;
}

export default function BarcodeScannerModal({ visible, onClose, onScan }: Props) {
  const scannedRef = useRef(false);

  useEffect(() => {
    if (visible) scannedRef.current = false;
  }, [visible]);

  const handleScan = (data: string) => {
    if (scannedRef.current) return;
    scannedRef.current = true;
    onScan(data);
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
                <Ionicons name="camera-outline" size={48} color="#999" />
                <Text style={{ color: '#ccc', marginTop: 12, fontSize: 14 }}>Camera not available in Expo Go</Text>
                <Text style={{ color: '#aaa', marginTop: 4, fontSize: 12 }}>Use a development build to scan barcodes</Text>
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
            <ScanReticle
              width={260}
              height={160}
              cornerColor="#FFFFFF"
              beamColor="#FFFFFF"
              gridColor="rgba(255,255,255,0.24)"
              surfaceColor="rgba(15,23,42,0.10)"
              active={visible}
            />
          </View>

          {/* Bottom */}
          <View style={styles.bottomBar}>
            {scannedRef.current && (
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  overlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'space-between' },
  topBar: { alignItems: 'center', paddingTop: 60, paddingBottom: 20, backgroundColor: 'rgba(0,0,0,0.6)' },
  title: { color: '#fff', fontSize: 18, fontWeight: '800' },
  subtitle: { color: 'rgba(255,255,255,0.7)', fontSize: 13, marginTop: 4 },
  viewfinderContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  bottomBar: { alignItems: 'center', paddingBottom: 50, paddingTop: 20, backgroundColor: 'rgba(0,0,0,0.6)' },
  cancelBtn: { backgroundColor: 'rgba(255,255,255,0.2)', paddingHorizontal: 32, paddingVertical: 14, borderRadius: 14 },
  cancelText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
