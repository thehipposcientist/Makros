import { View, Text, Modal, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRef, useEffect, useState } from 'react';
import ScanHudOverlay from './ScanHudOverlay';

interface Props {
  visible: boolean;
  onClose: () => void;
  onScan: (barcode: string) => void;
  processing?: boolean;
}

export default function BarcodeScannerModal({ visible, onClose, onScan, processing = false }: Props) {
  const scannedRef = useRef(false);
  const [hasScanned, setHasScanned] = useState(false);

  useEffect(() => {
    if (visible) {
      scannedRef.current = false;
      setHasScanned(false);
    }
  }, [visible]);

  const handleScan = (data: string) => {
    if (scannedRef.current) return;
    scannedRef.current = true;
    setHasScanned(true);
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
                onBarcodeScanned={hasScanned ? undefined : (result: any) => {
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
          <View style={styles.viewfinderContainer}>
            <ScanHudOverlay
              mode="barcode"
              active={visible}
              status={processing ? 'Matching product' : hasScanned ? 'Barcode captured' : undefined}
              accentColor="#FFFFFF"
              textColor="#FFFFFF"
              mutedTextColor="rgba(255,255,255,0.76)"
              surfaceColor="rgba(3,7,18,0.58)"
              reticleWidth={272}
              reticleHeight={166}
              style={styles.scanHud}
            />
          </View>

          <View style={styles.bottomBar}>
            <TouchableOpacity style={[styles.cancelBtn, processing && { opacity: 0.55 }]} onPress={onClose} disabled={processing}>
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
  viewfinderContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 22 },
  scanHud: {
    width: '100%',
    maxWidth: 360,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
  },
  bottomBar: { alignItems: 'center', paddingBottom: 50, paddingTop: 20, backgroundColor: 'rgba(0,0,0,0.6)' },
  cancelBtn: { backgroundColor: 'rgba(255,255,255,0.2)', paddingHorizontal: 32, paddingVertical: 14, borderRadius: 14 },
  cancelText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
