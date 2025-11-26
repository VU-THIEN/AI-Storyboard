export const CAMERA_MOVEMENTS = ["Static", "Pan Right", "Pan Left", "Tilt Up", "Tilt Down", "Dolly In", "Dolly Out", "Crane Shot", "Handheld", "Tracking Shot"] as const;
export const SHOT_TYPES = [
    "Extreme Wide Shot", 
    "Wide Shot", 
    "Full Shot", 
    "Medium Shot", 
    "Medium Close-up", 
    "Close-up", 
    "Extreme Close-up", 
    "Low Angle", 
    "High Angle", 
    "Over the Shoulder",
    "Dutch Angle"
] as const;
export const ASPECT_RATIOS = ["16:9", "9:16", "4:3", "3:4", "1:1", "2.39:1 (Anamorphic)"] as const;
// Updated Art Styles with Animation and Artistic options
export const ART_STYLES = [
    "Cinematic Realistic", 
    "Hyper-Realistic", 
    "Vintage Film", 
    "Noir Style", 
    "Cyberpunk Glow",
    "3D Animation (Pixar)", 
    "2D Anime (Ghibli)", 
    "Pencil Sketch", 
    "Oil Painting", 
    "Comic Book",
    "Watercolor",
    "Concept Art"
] as const;
export const LIGHTING_STYLES = ["Natural Daylight", "Golden Hour", "Blue Hour", "Studio Soft Light", "Hard Dramatic Light", "Night Neon", "Cinematic Volumetric", "Rembrandt Lighting"] as const;

export type CameraMovement = typeof CAMERA_MOVEMENTS[number];
export type ShotType = typeof SHOT_TYPES[number];
export type AspectRatio = typeof ASPECT_RATIOS[number];
export type ArtStyle = typeof ART_STYLES[number];
export type Lighting = typeof LIGHTING_STYLES[number];


export interface ShotSettings {
  cameraMovement: CameraMovement;
  shotType: ShotType; // Added Shot Type
  aspectRatio: AspectRatio;
  artStyle: ArtStyle;
  lighting: Lighting;
}

// Structure for a single image asset pair (Preview + Original)
export interface ImageAsset {
    id: string; // Unique ID for the variation
    previewUrl: string;
    originalUrl: string;
    previewFileSize: number;
    originalFileSize: number;
    createdAt: number;
}

export interface Shot {
  id: string;
  shotNumber: number;
  description: string;
  visualPrompt: string; // The optimized prompt for the AI image generator
  
  // New: Image Variations System
  imageVariations: ImageAsset[]; // Array of generated variations
  selectedVariationId?: string; // ID of the currently displayed image

  // Deprecated (kept for migration checking)
  imagePreviewUrl?: string; 
  imageOriginalUrl?: string; 
  imagePreviewFileSize?: number; 
  imageOriginalFileSize?: number;
  imageUrl?: string;

  isGeneratingImage: boolean;
  isUpdatingPrompt: boolean;
  settings: ShotSettings;
}

export interface Project {
  id: string;
  title: string;
  idea: string; // The user's original input
  shots: Shot[];
  trashedShots?: Shot[]; 
  createdAt: number;
  updatedAt: number;
  isTrashed?: boolean; // For project-level trash feature
}

export enum AppView {
  DASHBOARD = 'DASHBOARD',
  PROJECT_DETAIL = 'PROJECT_DETAIL',
}