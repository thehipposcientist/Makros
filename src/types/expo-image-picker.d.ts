declare module 'expo-image-picker' {
  export type ImagePickerAsset = {
    uri: string;
    base64?: string | null;
    mimeType?: string | null;
  };

  export type ImagePickerResult = {
    canceled: boolean;
    assets?: ImagePickerAsset[];
  };

  export function requestCameraPermissionsAsync(): Promise<{ granted: boolean }>;
  export function requestMediaLibraryPermissionsAsync(): Promise<{ granted: boolean }>;
  export function launchCameraAsync(options?: Record<string, unknown>): Promise<ImagePickerResult>;
  export function launchImageLibraryAsync(options?: Record<string, unknown>): Promise<ImagePickerResult>;
}
