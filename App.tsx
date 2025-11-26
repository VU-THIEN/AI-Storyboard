
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { ApiKeyChecker } from './components/ApiKeyChecker';
import { ProjectCard } from './components/ProjectCard';
import { ShotItem } from './components/ShotItem';
import { IconPlus, IconBack, IconCode, IconTrashOpen, IconRestore, IconTrash, IconX, IconSave, IconUpload, IconFileJson, IconEdit, IconFilm, IconKey, IconWarning } from './components/Icons';
import { Project, Shot, AppView, ShotSettings, ImageAsset } from './types';
import { generateScriptBreakdown, generateShotImage, regenerateVisualPrompt, getScriptSuggestions, editShotImage, getEffectiveApiKey } from './services/geminiService';
import { db } from './services/db';

// --- Helper Functions for Image Compression and Size Formatting ---

const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const compressImage = (base64Str: string, maxWidth = 800, quality = 0.7): Promise<string> => {
    return new Promise((resolve) => {
        const img = new Image();
        img.src = base64Str;
        img.onload = () => {
            const canvas = document.createElement('canvas');
            let width = img.width;
            let height = img.height;

            if (width > maxWidth) {
                height = (height * maxWidth) / width;
                width = maxWidth;
            }

            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx?.drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL('image/jpeg', quality)); // Compress to JPEG
        };
        img.onerror = () => {
             // If compression fails, return original
            resolve(base64Str);
        };
    });
};

const calculateBase64Size = (base64String: string) => {
    let padding = 0;
    if (base64String.endsWith('==')) padding = 2;
    else if (base64String.endsWith('=')) padding = 1;
    return (base64String.length * 3 / 4) - padding;
};

// Interface for Custom Confirm Dialog
interface ConfirmDialogState {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
}

type ApiKeyStatus = 'active' | 'warning' | 'error';

const App: React.FC = () => {
  const [isApiKeyReady, setIsApiKeyReady] = useState(false);
  const [apiKeyStatus, setApiKeyStatus] = useState<ApiKeyStatus>('active');
  
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentView, setCurrentView] = useState<AppView>(AppView.DASHBOARD);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const prevProjectsRef = useRef<Project[] | null>(null);
  
  // Shot Trash Feature State
  const [isShotTrashModalOpen, setIsShotTrashModalOpen] = useState(false);
  const [pendingShotDeletionId, setPendingShotDeletionId] = useState<string | null>(null);

  // --- NEW: Project Info Editing State ---
  const [isEditingProjectInfo, setIsEditingProjectInfo] = useState(false);
  const [editedTitle, setEditedTitle] = useState('');
  const [editedIdea, setEditedIdea] = useState('');

  // --- NEW: Project Trash Modal State ---
  const [isProjectTrashModalOpen, setIsProjectTrashModalOpen] = useState(false);

  // New Project State
  const [ideaInput, setIdeaInput] = useState('');
  
  // API State Management
  const [isApiBusy, setIsApiBusy] = useState(false);
  const [apiThrottle, setApiThrottle] = useState(0);
  const [rateLimitCooldown, setRateLimitCooldown] = useState(0);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [isExportingHtml, setIsExportingHtml] = useState(false);

  // Confirm Dialog State
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);

  const requestConfirmation = useCallback(
    (dialog: Omit<ConfirmDialogState, 'confirmLabel' | 'cancelLabel'> & Partial<Pick<ConfirmDialogState, 'confirmLabel' | 'cancelLabel'>>) => {
      setConfirmDialog({
        ...dialog,
        confirmLabel: dialog.confirmLabel || 'Đồng ý',
        cancelLabel: dialog.cancelLabel || 'Hủy',
      });
    },
    []
  );

  // INITIAL LOAD: Load from DB + Migrate from LocalStorage if needed
  useEffect(() => {
    const initializeData = async () => {
        try {
            // 1. Check LocalStorage for legacy data
            const localData = localStorage.getItem('cinevision_projects');
            if (localData) {
                console.log("Found legacy data in LocalStorage. Migrating to IndexedDB...");
                try {
                    const parsed: Project[] = JSON.parse(localData);
                    // Perform structure migration on legacy data
                    const migrated = await Promise.all(parsed.map(async (p) => {
                         // ... (Re-use the migration logic you had, simplified for brevity but essential)
                         const migratedShots = await Promise.all(p.shots.map(async (s) => {
                            const shot = { ...s, imageVariations: s.imageVariations || [] };
                            if ((s.imageOriginalUrl || s.imageUrl) && shot.imageVariations.length === 0) {
                                const originalUrl = s.imageOriginalUrl || s.imageUrl || "";
                                const originalSize = s.imageOriginalFileSize || calculateBase64Size(originalUrl);
                                let previewUrl = s.imagePreviewUrl;
                                let previewSize = s.imagePreviewFileSize;
                                if (!previewUrl) {
                                    previewUrl = await compressImage(originalUrl);
                                    previewSize = calculateBase64Size(previewUrl);
                                }
                                const newVar: ImageAsset = {
                                    id: uuidv4(), originalUrl, previewUrl: previewUrl!, originalFileSize: originalSize!, previewFileSize: previewSize!, createdAt: Date.now()
                                };
                                shot.imageVariations = [newVar];
                                shot.selectedVariationId = newVar.id;
                            }
                            delete shot.imageUrl; delete shot.imageOriginalUrl; delete shot.imagePreviewUrl;
                            return shot;
                         }));
                         return { ...p, shots: migratedShots };
                    }));
                    
                    // Save to DB
                    await db.saveAllProjects(migrated);
                    // Clear LocalStorage to free up space and mark migration done
                    localStorage.removeItem('cinevision_projects');
                } catch (e) {
                    console.error("Migration failed:", e);
                }
            }

            // 2. Load from IndexedDB
            const dbProjects = await db.getProjects();
            setProjects(dbProjects);
        } catch (error) {
            console.error("Failed to initialize data:", error);
            setGlobalError("Lỗi khởi tạo cơ sở dữ liệu.");
        }
    };
    
    initializeData();
  }, []);

  // OPTIMIZED AUTO-SAVE: Debounce saves and only persist changed projects (by updatedAt)
  useEffect(() => {
     if (projects.length === 0) return;

     const saveTimeout = setTimeout(() => {
         const prevProjects = prevProjectsRef.current;
         const changedProjects: Project[] = [];

         if (!prevProjects) {
           // First run: treat all as changed
           changedProjects.push(...projects);
         } else {
           // Only persist projects whose updatedAt changed or are newly added
           for (const project of projects) {
             const old = prevProjects.find(p => p.id === project.id);
             if (!old || old.updatedAt !== project.updatedAt) {
               changedProjects.push(project);
             }
           }
         }

         changedProjects.forEach(p => {
           db.saveProject(p).catch(e => console.error("Auto-save failed for project", p.id, e));
         });

         if (changedProjects.length > 0) {
           console.log(`Auto-saved ${changedProjects.length} project(s) to IndexedDB`);
         }

         // Update snapshot for next comparison
         prevProjectsRef.current = projects;
     }, 1000); // Wait 1 second after last change

     return () => clearTimeout(saveTimeout);
  }, [projects]);


  // Cooldown Timer Effect
  useEffect(() => {
    if (rateLimitCooldown > 0) {
      const timer = setTimeout(() => {
        setRateLimitCooldown(prev => prev - 1);
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [rateLimitCooldown]);
  
  // Proactive Throttling Timer Effect
  useEffect(() => {
    if (apiThrottle > 0) {
      const timer = setTimeout(() => {
        setApiThrottle(prev => prev - 1);
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [apiThrottle]);


  const handleApiError = useCallback((error: any) => {
    console.error(error);
    const errorMessage = error?.message || "Lỗi không xác định.";
    const upperMsg = errorMessage.toUpperCase();

    // Smart Status Update
    if (upperMsg.includes("429") || upperMsg.includes("RESOURCE_EXHAUSTED") || upperMsg.includes("RATE LIMIT")) {
        setRateLimitCooldown(60);
        setApiKeyStatus('warning');
        setGlobalError(null);
    } else if (upperMsg.includes("PERMISSION_DENIED") || upperMsg.includes("API_KEY") || upperMsg.includes("403")) {
        setApiKeyStatus('error');
        setGlobalError(errorMessage);
    } else {
        setGlobalError(errorMessage);
    }
  }, []);

  const handleCreateProject = async () => {
    if (!ideaInput.trim() || isApiBusy || apiThrottle > 0) return;

    setIsApiBusy(true);
    setGlobalError(null);
    try {
      const shotsData = await generateScriptBreakdown(ideaInput);
      
      const newShots: Shot[] = shotsData.map((s: any) => ({
        id: uuidv4(),
        shotNumber: s.shotNumber,
        description: s.description,
        visualPrompt: s.visualPrompt,
        // Init new fields
        imageVariations: [],
        selectedVariationId: undefined,

        isGeneratingImage: false,
        isUpdatingPrompt: false,
        settings: {
            cameraMovement: 'Static',
            shotType: 'Medium Shot', // Default shot type
            aspectRatio: '16:9',
            artStyle: 'Cinematic Realistic',
            lighting: 'Natural Daylight',
        },
      }));

      const newProject: Project = {
        id: uuidv4(),
        title: ideaInput.slice(0, 30) + (ideaInput.length > 30 ? '...' : ''),
        idea: ideaInput,
        shots: newShots,
        trashedShots: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        isTrashed: false,
      };

      setProjects(prev => [newProject, ...prev]);
      // DB Save is handled by useEffect
      
      setSelectedProjectId(newProject.id);
      setCurrentView(AppView.PROJECT_DETAIL);
      setIdeaInput('');
      // If successful, reset status to active if it was warning
      if (apiKeyStatus === 'warning') setApiKeyStatus('active');
    } catch (error) {
      handleApiError(error);
    } finally {
      setIsApiBusy(false);
      setApiThrottle(3); 
    }
  };

  const processAndSaveImage = async (base64Original: string): Promise<ImageAsset> => {
      const originalSize = calculateBase64Size(base64Original);
      const base64Preview = await compressImage(base64Original);
      const previewSize = calculateBase64Size(base64Preview);
      
      return {
          id: uuidv4(),
          originalUrl: base64Original,
          previewUrl: base64Preview,
          originalFileSize: originalSize,
          previewFileSize: previewSize,
          createdAt: Date.now()
      };
  };

  const handleGenerateImage = async (shotId: string, referenceShotId?: string, customReferenceBase64?: string) => {
    if (!selectedProjectId || isApiBusy || apiThrottle > 0) return;
    
    const project = projects.find(p => p.id === selectedProjectId);
    if (!project) return;
    
    const shot = project.shots.find(s => s.id === shotId);
    if (!shot) return;

    let referenceImageUrl: string | undefined;

    // Logic: Prioritize Custom Upload -> Then previous shot
    if (customReferenceBase64) {
        referenceImageUrl = customReferenceBase64;
    } else if (referenceShotId) {
        // Use the active variation of the reference shot
        const refShot = project.shots.find(s => s.id === referenceShotId);
        if (refShot && refShot.selectedVariationId) {
            const activeVar = refShot.imageVariations.find(v => v.id === refShot.selectedVariationId);
            referenceImageUrl = activeVar?.originalUrl;
        }
    }

    setGlobalError(null);
    setIsApiBusy(true);
    setProjects(prev => prev.map(p => {
      if (p.id !== selectedProjectId) return p;
      return { ...p, shots: p.shots.map(s => s.id === shotId ? { ...s, isGeneratingImage: true } : s) };
    }));

    try {
      // GENERATE 2 VARIATIONS IN PARALLEL
      const promise1 = generateShotImage(shot.visualPrompt, shot.settings, referenceImageUrl);
      const promise2 = generateShotImage(shot.visualPrompt, shot.settings, referenceImageUrl); // Second variation

      const results = await Promise.allSettled([promise1, promise2]);
      
      const successfulImages: string[] = [];
      results.forEach(res => {
          if (res.status === 'fulfilled') successfulImages.push(res.value);
      });

      if (successfulImages.length === 0) {
          throw new Error("Không thể tạo được ảnh nào.");
      }

      // Process and Compress Images
      const newVariations = await Promise.all(successfulImages.map(img => processAndSaveImage(img)));

      setProjects(prev => prev.map(p => {
        if (p.id !== selectedProjectId) return p;
        return { 
            ...p, 
            updatedAt: Date.now(), 
            shots: p.shots.map(s => {
                if (s.id !== shotId) return s;
                
                const updatedVariations = [...newVariations, ...s.imageVariations];
                
                return { 
                    ...s, 
                    imageVariations: updatedVariations,
                    selectedVariationId: newVariations[0].id, // Select the first new one
                    isGeneratingImage: false 
                };
            }) 
        };
      }));
      // If successful, reset status
      if (apiKeyStatus === 'warning') setApiKeyStatus('active');
    } catch (error: any) {
      handleApiError(error);
      setProjects(prev => prev.map(p => {
        if (p.id !== selectedProjectId) return p;
        return { ...p, shots: p.shots.map(s => s.id === shotId ? { ...s, isGeneratingImage: false } : s) };
      }));
    } finally {
      setIsApiBusy(false);
      setApiThrottle(3); 
    }
  };

  const handleEditShotImage = async (shotId: string, instruction: string) => {
    if (!selectedProjectId || isApiBusy || apiThrottle > 0) return;
    
    const project = projects.find(p => p.id === selectedProjectId);
    if (!project) return;
    const shot = project.shots.find(s => s.id === shotId);
    if (!shot || !shot.selectedVariationId) return;

    const currentVariation = shot.imageVariations.find(v => v.id === shot.selectedVariationId);
    if (!currentVariation) return;

    setGlobalError(null);
    setIsApiBusy(true);
    setProjects(prev => prev.map(p => {
      if (p.id !== selectedProjectId) return p;
      return { ...p, shots: p.shots.map(s => s.id === shotId ? { ...s, isGeneratingImage: true } : s) };
    }));

    try {
        const editedImageBase64 = await editShotImage(currentVariation.originalUrl, instruction);
        const newVariation = await processAndSaveImage(editedImageBase64);

        setProjects(prev => prev.map(p => {
            if (p.id !== selectedProjectId) return p;
            return { 
                ...p, 
                updatedAt: Date.now(), 
                shots: p.shots.map(s => {
                    if (s.id !== shotId) return s;
                    return { 
                        ...s, 
                        imageVariations: [newVariation, ...s.imageVariations],
                        selectedVariationId: newVariation.id,
                        isGeneratingImage: false 
                    };
                }) 
            };
        }));
        if (apiKeyStatus === 'warning') setApiKeyStatus('active');

    } catch (error: any) {
        handleApiError(error);
        setProjects(prev => prev.map(p => {
            if (p.id !== selectedProjectId) return p;
            return { ...p, shots: p.shots.map(s => s.id === shotId ? { ...s, isGeneratingImage: false } : s) };
        }));
    } finally {
        setIsApiBusy(false);
        setApiThrottle(3);
    }
  }

  const handleSelectVariation = (shotId: string, variationId: string) => {
    if (!selectedProjectId) return;
    setProjects(prev => prev.map(p => {
        if (p.id !== selectedProjectId) return p;
        return {
            ...p,
            updatedAt: Date.now(),
            shots: p.shots.map(s => s.id === shotId ? { ...s, selectedVariationId: variationId } : s)
        };
    }));
  };

  const handleDeleteProject = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setProjects(prev => prev.map(p => p.id === id ? { ...p, isTrashed: true, updatedAt: Date.now() } : p));
    if (selectedProjectId === id) {
      setSelectedProjectId(null);
      setCurrentView(AppView.DASHBOARD);
    }
  };
  
  // --- NEW: Project Trash Handlers ---
  const handleRestoreProject = (id: string) => {
    setProjects(prev => prev.map(p => p.id === id ? { ...p, isTrashed: false, updatedAt: Date.now() } : p));
  };

  const handlePermanentlyDeleteProject = (id: string) => {
    requestConfirmation({
      title: "Xóa vĩnh viễn dự án",
      message: "Hành động này không thể hoàn tác. Bạn có chắc chắn muốn xóa vĩnh viễn dự án này?",
      confirmLabel: "Xóa vĩnh viễn",
      cancelLabel: "Giữ lại",
      onConfirm: () => {
          setProjects(prev => prev.filter(p => p.id !== id));
          // Explicitly delete from DB
          db.deleteProject(id);
      },
    });
  };

  const handleEmptyProjectTrash = () => {
    requestConfirmation({
      title: "Dọn sạch thùng rác",
      message: "Bạn có chắc chắn muốn xóa vĩnh viễn TOÀN BỘ các dự án trong thùng rác?",
      confirmLabel: "Dọn sạch",
      onConfirm: () => {
          // Identify IDs to delete from DB
          const idsToDelete = projects.filter(p => p.isTrashed).map(p => p.id);
          idsToDelete.forEach(id => db.deleteProject(id));
          
          setProjects(prev => prev.filter(p => !p.isTrashed));
      },
    });
  };

  // --- NEW: Project Info Editing Handlers ---
  const handleEditProjectInfo = () => {
    if (!currentProject) return;
    setEditedTitle(currentProject.title);
    setEditedIdea(currentProject.idea);
    setIsEditingProjectInfo(true);
  };

  const handleCancelEditProjectInfo = () => {
    setIsEditingProjectInfo(false);
  };

  const handleSaveProjectInfo = () => {
    if (!selectedProjectId) return;
    setProjects(prev => prev.map(p => {
      if (p.id === selectedProjectId) {
        return { ...p, title: editedTitle, idea: editedIdea, updatedAt: Date.now() };
      }
      return p;
    }));
    setIsEditingProjectInfo(false);
  };

  const handleUpdateShotDescription = async (shotId: string, newDescription: string) => {
    if (!selectedProjectId || isApiBusy || apiThrottle > 0) return;

    setGlobalError(null);
    setIsApiBusy(true);
    setProjects(prev => prev.map(p => {
        if (p.id !== selectedProjectId) return p;
        const newShots = p.shots.map(s => (s.id === shotId) ? { ...s, description: newDescription, isUpdatingPrompt: true } : s);
        return { ...p, shots: newShots, updatedAt: Date.now() };
    }));

    try {
        const newVisualPrompt = await regenerateVisualPrompt(newDescription);
        setProjects(prev => prev.map(p => {
            if (p.id !== selectedProjectId) return p;
            return { ...p, shots: p.shots.map(s => (s.id === shotId) ? { ...s, visualPrompt: newVisualPrompt, isUpdatingPrompt: false } : s) };
        }));
        if (apiKeyStatus === 'warning') setApiKeyStatus('active');
    } catch (error: any) {
        handleApiError(error);
        setProjects(prev => prev.map(p => {
            if (p.id !== selectedProjectId) return p;
            return { ...p, shots: p.shots.map(s => (s.id === shotId) ? { ...s, isUpdatingPrompt: false } : s) };
        }));
    } finally {
        setIsApiBusy(false);
        setApiThrottle(3); 
    }
  };
  
  const handleUpdateVisualPrompt = (shotId: string, newPrompt: string) => {
    if (!selectedProjectId) return;
    setProjects(prevProjects => prevProjects.map(p => {
      if (p.id !== selectedProjectId) return p;
      const updatedShots = p.shots.map(s =>
        s.id === shotId ? { ...s, visualPrompt: newPrompt } : s
      );
      return { ...p, shots: updatedShots, updatedAt: Date.now() };
    }));
  };

  const handleUpdateShotSettings = (shotId: string, newSettings: Partial<ShotSettings>) => {
    if (!selectedProjectId) return;

    setProjects(prev => prev.map(p => {
        if (p.id !== selectedProjectId) return p;
        const newShots = p.shots.map(s => {
            if (s.id === shotId) {
                return { ...s, settings: { ...s.settings, ...newSettings } };
            }
            return s;
        });
        return { ...p, shots: newShots, updatedAt: Date.now() };
    }));
  };

  const handleGetSuggestionsForShot = async (projectIdea: string, currentDescription: string): Promise<string[] | undefined> => {
    if (isApiBusy || apiThrottle > 0) return;
    setGlobalError(null);
    setIsApiBusy(true);
    try {
        const suggestions = await getScriptSuggestions(projectIdea, currentDescription);
        return suggestions;
    } catch (error) {
        handleApiError(error);
        return undefined;
    } finally {
        setIsApiBusy(false);
        setApiThrottle(3); 
    }
  };

  const handleAddShotAfter = (previousShotId: string) => {
    if (!selectedProjectId) return;
    setProjects(currentProjects => currentProjects.map(project => {
        if (project.id !== selectedProjectId) return project;
        const shotIndex = project.shots.findIndex(s => s.id === previousShotId);
        if (shotIndex === -1) return project;
        const newShot: Shot = {
            id: uuidv4(), shotNumber: 0, description: "Mô tả cảnh quay mới.", visualPrompt: "A new scene",
            isGeneratingImage: false, isUpdatingPrompt: false, 
            imageVariations: [],
            settings: { cameraMovement: 'Static', shotType: 'Medium Shot', aspectRatio: '16:9', artStyle: 'Cinematic Realistic', lighting: 'Natural Daylight' },
        };
        const newShots = [
            ...project.shots.slice(0, shotIndex + 1),
            newShot,
            ...project.shots.slice(shotIndex + 1),
        ];
        const renumberedShots = newShots.map((shot, index) => ({ ...shot, shotNumber: index + 1 }));
        return { ...project, shots: renumberedShots, updatedAt: Date.now() };
    }));
  };

  const handleInitiateDeleteShot = (shotId: string) => {
    setPendingShotDeletionId(shotId);
  };

  const handleCancelDeleteShot = () => {
    setPendingShotDeletionId(null);
  };

  const handleConfirmDeleteShot = () => {
      const shotId = pendingShotDeletionId;
      if (!shotId || !selectedProjectId) return;
      setProjects(currentProjects => currentProjects.map(project => {
          if (project.id !== selectedProjectId) return project;
          const shotToTrash = project.shots.find(s => s.id === shotId);
          if (!shotToTrash) return project;
          const remainingShots = project.shots.filter(s => s.id !== shotId);
          const renumberedShots = remainingShots.map((shot, index) => ({ ...shot, shotNumber: index + 1 }));
          const updatedTrashedShots = [...(project.trashedShots || []), shotToTrash];
          return { ...project, shots: renumberedShots, trashedShots: updatedTrashedShots, updatedAt: Date.now() };
      }));
      setPendingShotDeletionId(null); 
  };
  
  const handleRestoreShot = (shotId: string) => {
      if (!selectedProjectId) return;
      setProjects(currentProjects => currentProjects.map(project => {
          if (project.id !== selectedProjectId) return project;
          const shotToRestore = project.trashedShots?.find(s => s.id === shotId);
          if (!shotToRestore) return project;
          const updatedTrashedShots = project.trashedShots.filter(s => s.id !== shotId);
          const restoredShotsList = [...project.shots, shotToRestore].sort((a,b) => a.shotNumber - b.shotNumber);
          const renumberedShots = restoredShotsList.map((shot, index) => ({ ...shot, shotNumber: index + 1 }));
          return { ...project, shots: renumberedShots, trashedShots: updatedTrashedShots, updatedAt: Date.now() };
      }));
  };

  const handlePermanentlyDeleteShot = (shotId: string) => {
      if (!selectedProjectId) return;
      requestConfirmation({
        title: "Xóa vĩnh viễn cảnh quay",
        message: "Bạn có chắc chắn muốn xóa vĩnh viễn cảnh này?",
        confirmLabel: "Xóa vĩnh viễn",
        onConfirm: () => {
          setProjects(currentProjects => currentProjects.map(project => {
              if (project.id !== selectedProjectId) return project;
              const updatedTrashedShots = (project.trashedShots || []).filter(s => s.id !== shotId);
              return { ...project, trashedShots: updatedTrashedShots, updatedAt: Date.now() };
          }));
        }
      });
  };

  const handleEmptyTrash = () => {
      if (!selectedProjectId) return;
      requestConfirmation({
        title: "Dọn sạch thùng rác cảnh quay",
        message: "Bạn có chắc chắn muốn xóa vĩnh viễn TOÀN BỘ các cảnh trong thùng rác?",
        confirmLabel: "Dọn sạch",
        onConfirm: () => {
          setProjects(currentProjects => currentProjects.map(project => {
              if (project.id !== selectedProjectId) return project;
              return { ...project, trashedShots: [], updatedAt: Date.now() };
          }));
        }
      });
  };


  const handleExportToHtml = async () => {
    if (!currentProject) return;
    const storyboardElement = document.getElementById('storyboard-content');
    if (!storyboardElement) {
        setGlobalError("Không thể tìm thấy nội dung để xuất file.");
        return;
    }

    setIsExportingHtml(true);
    setGlobalError(null);

    try {
        const contentHtml = storyboardElement.innerHTML;
        const headContent = `
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>${currentProject.title} - Storyboard</title>
            <script src="https://cdn.tailwindcss.com"></script>
            <script>
              tailwind.config = {
                theme: {
                  extend: {
                    colors: {
                      cinematic: {
                        900: '#0f172a',
                        800: '#1e2b3b',
                        700: '#334155',
                        accent: '#06b6d4',
                        accentHover: '#0891b2',
                      }
                    },
                    fontFamily: {
                      sans: ['Inter', 'sans-serif'],
                    }
                  }
                }
              }
            </script>
            <style>
              body {
                background-color: #0f172a;
                color: #f8fafc;
                padding: 2rem;
              }
              ::-webkit-scrollbar { width: 8px; height: 8px; }
              ::-webkit-scrollbar-track { background: #1e293b; }
              ::-webkit-scrollbar-thumb { background: #475569; border-radius: 4px; }
              ::-webkit-scrollbar-thumb:hover { background: #64748b; }
            </style>
        `;

        const fullHtml = `
<!DOCTYPE html>
<html lang="vi">
<head>
    ${headContent}
</head>
<body>
    <div class="max-w-7xl mx-auto">
      ${contentHtml}
    </div>
</body>
</html>`;

        const blob = new Blob([fullHtml], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${currentProject.title.replace(/ /g, '_')}_storyboard.html`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

    } catch (error) {
        console.error("Lỗi khi xuất HTML:", error);
        setGlobalError("Đã xảy ra lỗi trong quá trình xuất file HTML.");
    } finally {
        setIsExportingHtml(false);
    }
  };

  const handleExportJson = () => {
    if (!currentProject) return;
    try {
        const projectData = JSON.stringify(currentProject, null, 2);
        const blob = new Blob([projectData], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${currentProject.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_backup.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (error) {
        console.error("Export Error:", error);
        setGlobalError("Không thể tạo file sao lưu.");
    }
  };

  const handleImportJson = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const content = e.target?.result as string;
            const parsedProject: Project = JSON.parse(content);
            
            if (!parsedProject.id || !parsedProject.shots) {
                throw new Error("File không hợp lệ.");
            }

            // Migration on Import: Ensure structure fits new Variations model
            parsedProject.shots = await Promise.all(parsedProject.shots.map(async (s) => {
                 const shot = { ...s };
                 
                 // If import has old structure
                 if (!shot.imageVariations) shot.imageVariations = [];

                 if ((shot.imageUrl || shot.imageOriginalUrl) && shot.imageVariations.length === 0) {
                     const orig = shot.imageOriginalUrl || shot.imageUrl || "";
                     const origSize = shot.imageOriginalFileSize || calculateBase64Size(orig);
                     
                     let prev = shot.imagePreviewUrl;
                     let prevSize = shot.imagePreviewFileSize;
                     
                     if (!prev) {
                         prev = await compressImage(orig);
                         prevSize = calculateBase64Size(prev);
                     }
                     
                     const newVar: ImageAsset = {
                         id: uuidv4(), originalUrl: orig, previewUrl: prev!, originalFileSize: origSize!, previewFileSize: prevSize!, createdAt: Date.now()
                     };
                     shot.imageVariations = [newVar];
                     shot.selectedVariationId = newVar.id;
                 }
                 
                 // Ensure settings exist
                 if (!shot.settings) {
                     shot.settings = { cameraMovement: 'Static', shotType: 'Medium Shot', aspectRatio: '16:9', artStyle: 'Cinematic Realistic', lighting: 'Natural Daylight' };
                 } else if (!shot.settings.shotType) {
                     shot.settings.shotType = 'Medium Shot';
                 }
                 
                 // Cleanup
                 delete shot.imageUrl; delete shot.imageOriginalUrl; delete shot.imagePreviewUrl;

                 return shot;
            }));

            parsedProject.id = uuidv4(); 
            parsedProject.title = parsedProject.title + " (Imported)";
            
            setProjects(prev => [parsedProject, ...prev]);
            setGlobalError(null);
            alert("Đã nhập dự án thành công!");
        } catch (error) {
            console.error("Import Error:", error);
            setGlobalError("File bị lỗi hoặc không đúng định dạng.");
        } finally {
             if (fileInputRef.current) fileInputRef.current.value = "";
        }
    };
    reader.readAsText(file);
  };
  
  // --- NEW: Reset Key Handler ---
  const handleResetApiKey = () => {
    let message = "Bạn có chắc chắn muốn xóa API Key hiện tại không? Ứng dụng sẽ tải lại để bạn nhập Key mới.";
    let confirmLabel = "Xóa & Tải lại";

    if (apiKeyStatus === 'warning') {
        message = "API Key hiện tại đang bị giới hạn (Hết hạn ngạch). Bạn nên đổi Key khác để tiếp tục sử dụng ngay.";
        confirmLabel = "Đổi Key ngay";
    } else if (apiKeyStatus === 'error') {
        message = "API Key hiện tại KHÔNG HỢP LỆ hoặc đã bị thu hồi. Vui lòng nhập Key mới để sử dụng ứng dụng.";
        confirmLabel = "Nhập Key mới";
    }

    requestConfirmation({
      title: "Đổi API Key",
      message: message,
      confirmLabel: confirmLabel,
      onConfirm: () => {
          localStorage.removeItem('user_gemini_api_key');
          window.location.reload();
      },
    });
  };

  const currentProject = projects.find(p => p.id === selectedProjectId);
  const trashedProjects = projects.filter(p => p.isTrashed);

  if (!isApiKeyReady) {
    return <ApiKeyChecker onReady={() => setIsApiKeyReady(true)} />;
  }

  // Calculate key hint
  const currentApiKey = getEffectiveApiKey();
  const keyHint = currentApiKey && currentApiKey.length > 5 ? `...${currentApiKey.slice(-5)}` : 'Mặc định';

  return (
    <div className="min-h-screen bg-cinematic-900 text-slate-100 font-sans selection:bg-cinematic-accent selection:text-white">
      <header className="sticky top-0 z-50 border-b border-cinematic-700 bg-cinematic-900/90 backdrop-blur-md px-6 py-4 shadow-sm">
        <div className="flex items-center justify-between mx-auto max-w-7xl">
          <div className="flex items-center gap-3">
             <div className="h-8 w-8 bg-gradient-to-tr from-cinematic-accent to-blue-600 rounded-lg"></div>
             <h1 className="text-xl font-bold tracking-tight">CineVision AI</h1>
          </div>
          
          <div className="flex items-center gap-4">
              {currentView === AppView.PROJECT_DETAIL && (
                 <button 
                    onClick={() => {
                      setCurrentView(AppView.DASHBOARD);
                      setGlobalError(null);
                      setRateLimitCooldown(0);
                    }}
                    className="flex items-center gap-2 text-sm text-slate-400 hover:text-white transition-colors disabled:opacity-50"
                 >
                    <IconBack />
                    Quay lại danh sách
                 </button>
              )}
              
              <button 
                onClick={handleResetApiKey}
                className={`flex items-center gap-2 text-xs transition-colors px-3 py-1.5 rounded-full border 
                    ${apiKeyStatus === 'active' ? 'text-slate-500 hover:text-cinematic-accent bg-cinematic-800/50 border-cinematic-700/50' : ''}
                    ${apiKeyStatus === 'warning' ? 'text-yellow-300 bg-yellow-900/30 border-yellow-600 animate-pulse' : ''}
                    ${apiKeyStatus === 'error' ? 'text-red-300 bg-red-900/30 border-red-600 animate-pulse' : ''}
                `}
                title={apiKeyStatus === 'active' 
                    ? `Đổi API Key (Đang dùng: ${keyHint})` 
                    : `API Key đang gặp sự cố (Đang dùng: ${keyHint}) - Bấm để sửa`}
              >
                  {apiKeyStatus === 'warning' || apiKeyStatus === 'error' ? <IconWarning /> : <IconKey />}
                  <span>
                      {apiKeyStatus === 'active' && "API Key"}
                      {apiKeyStatus === 'warning' && "Hệ thống bận"}
                      {apiKeyStatus === 'error' && "Lỗi Key"}
                  </span>
              </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8">
        {currentView === AppView.DASHBOARD && (
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
            <div className="lg:col-span-1">
              <div className="sticky top-24 rounded-2xl border border-cinematic-700 bg-cinematic-800 p-6 shadow-xl">
                <h2 className="mb-4 text-lg font-semibold text-white">Tạo dự án mới</h2>
                <div className="mb-4">
                  <label className="mb-2 block text-sm font-medium text-slate-400">Ý tưởng phim / Kịch bản tóm tắt</label>
                  <textarea
                    value={ideaInput}
                    onChange={(e) => setIdeaInput(e.target.value)}
                    placeholder="Một thám tử tương lai đi tìm ký ức đã mất trong thành phố Cyberpunk..."
                    className="w-full h-40 rounded-lg bg-cinematic-900 border border-cinematic-700 p-3 text-sm text-white placeholder-slate-500 focus:border-cinematic-accent focus:outline-none focus:ring-1 focus:ring-cinematic-accent resize-none"
                  />
                </div>
                <button
                  onClick={handleCreateProject}
                  disabled={isApiBusy || !ideaInput.trim() || rateLimitCooldown > 0 || apiThrottle > 0}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-cinematic-accent to-blue-600 px-4 py-3 font-semibold text-white shadow-lg transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 active:scale-95"
                >
                  {isApiBusy ? (
                    <>
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"></div>
                      Đang xử lý...
                    </>
                  ) : (
                    <>
                      <IconPlus />
                      Phân tích & Lên Kịch bản
                    </>
                  )}
                </button>
                
                <div className="mt-6 pt-6 border-t border-cinematic-700 flex flex-col gap-2">
                    <input 
                        type="file" 
                        ref={fileInputRef}
                        accept=".json" 
                        className="hidden" 
                        onChange={handleImportJson}
                    />
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        className="flex w-full items-center justify-center gap-2 rounded-lg bg-cinematic-700 px-4 py-2 text-sm font-semibold text-slate-300 transition-all hover:bg-cinematic-600 hover:text-white"
                    >
                        <IconUpload />
                        Nhập dự án từ file (.json)
                    </button>
                    <button
                        onClick={() => setIsProjectTrashModalOpen(true)}
                        disabled={trashedProjects.length === 0}
                        className="relative flex w-full items-center justify-center gap-2 rounded-lg bg-cinematic-700 px-4 py-2 text-sm font-semibold text-slate-300 transition-all hover:bg-cinematic-600 hover:text-white disabled:opacity-50"
                    >
                        <IconTrashOpen />
                        Thùng rác dự án
                        {trashedProjects.length > 0 && (
                            <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-xs font-bold">
                                {trashedProjects.length}
                            </span>
                        )}
                    </button>
                </div>

              </div>
            </div>

            <div className="lg:col-span-2 space-y-6">
              <h2 className="text-xl font-semibold text-white">Dự án đã lưu</h2>
              {projects.filter(p => !p.isTrashed).length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-cinematic-700 bg-cinematic-800/50 py-20 text-slate-500">
                  <p>Chưa có dự án nào.</p>
                  <p className="text-sm">Hãy nhập ý tưởng bên trái để bắt đầu.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {projects.filter(p => !p.isTrashed).map(project => (
                    <ProjectCard 
                      key={project.id} 
                      project={project} 
                      onSelect={(id) => {
                        setSelectedProjectId(id);
                        setCurrentView(AppView.PROJECT_DETAIL);
                      }}
                      onDelete={handleDeleteProject}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {currentView === AppView.PROJECT_DETAIL && currentProject && (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
             {(rateLimitCooldown > 0 || globalError) && (
                <div className={`p-4 mb-6 rounded-lg text-sm flex justify-between items-center ${rateLimitCooldown > 0 ? 'bg-yellow-900/50 text-yellow-300 border border-yellow-700' : 'bg-red-900/50 text-red-300 border border-red-700'}`}>
                    <span>
                        {rateLimitCooldown > 0 ? (
                            `Hệ thống đang quá tải. Mọi chức năng AI sẽ được mở lại sau ${rateLimitCooldown} giây.`
                        ) : (
                           <><strong>Lỗi:</strong> {globalError}</>
                        )}
                    </span>
                    <button onClick={() => { setGlobalError(null); setRateLimitCooldown(0); }} className="font-bold opacity-70 hover:opacity-100">&times;</button>
                </div>
             )}

            <div className="flex justify-between items-start mb-4 flex-wrap gap-4">
                {isEditingProjectInfo ? (
                    <div className="flex-grow space-y-2">
                        <input 
                            type="text" 
                            value={editedTitle}
                            onChange={e => setEditedTitle(e.target.value)}
                            className="w-full text-3xl font-bold bg-cinematic-700 rounded-lg p-2 focus:outline-none focus:ring-2 focus:ring-cinematic-accent"
                        />
                         <textarea 
                            value={editedIdea}
                            onChange={e => setEditedIdea(e.target.value)}
                            className="w-full text-lg text-slate-300 bg-cinematic-700 rounded-lg p-2 focus:outline-none focus:ring-2 focus:ring-cinematic-accent h-24 resize-y"
                        />
                        <div className="flex gap-2">
                            <button onClick={handleSaveProjectInfo} className="flex items-center gap-1 text-xs text-green-400 p-2 rounded-md hover:bg-green-500/20"><IconSave /> Lưu</button>
                            <button onClick={handleCancelEditProjectInfo} className="flex items-center gap-1 text-xs text-slate-400 p-2 rounded-md hover:bg-cinematic-600"><IconX /> Hủy</button>
                        </div>
                    </div>
                ) : (
                    <div>
                        <div className="flex items-center gap-3">
                            <h2 className="text-3xl font-bold text-white max-w-lg truncate" title={currentProject.title}>{currentProject.title}</h2>
                            <button onClick={handleEditProjectInfo} className="text-slate-500 hover:text-white disabled:opacity-50"><IconEdit /></button>
                        </div>
                        <p className="text-slate-400 text-lg leading-relaxed max-w-4xl mt-2">{currentProject.idea}</p>
                    </div>
                )}
                
                <div className="flex items-center gap-2 shrink-0">
                     <button
                        onClick={handleExportJson}
                        className="flex items-center justify-center gap-2 rounded-lg bg-cinematic-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-cinematic-600 border border-cinematic-600 disabled:opacity-50"
                        title="Tải file dự án về máy tính để sao lưu"
                    >
                        <IconFileJson />
                        Sao lưu (.json)
                    </button>
                    <button
                        onClick={() => setIsShotTrashModalOpen(true)}
                        disabled={!currentProject.trashedShots?.length}
                        className="relative flex items-center justify-center gap-2 rounded-lg bg-cinematic-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-cinematic-600 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <IconTrashOpen />
                      Thùng rác cảnh
                      {currentProject.trashedShots && currentProject.trashedShots.length > 0 && (
                        <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-xs font-bold">
                          {currentProject.trashedShots.length}
                        </span>
                      )}
                    </button>
                    <button
                        onClick={handleExportToHtml}
                        disabled={isExportingHtml}
                        className="flex items-center justify-center gap-2 rounded-lg bg-cinematic-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-cinematic-600 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {isExportingHtml ? (
                            <>
                                <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"></div>
                                Đang xuất...
                            </>
                        ) : (
                            <>
                                <IconCode />
                                Xuất ra HTML
                            </>
                        )}
                    </button>
                </div>
            </div>

            <div id="storyboard-content">
                <div className="mb-8 border-b border-cinematic-700 pb-6">
                    {!isEditingProjectInfo && (
                       <div className="mt-4 flex gap-4 text-sm text-slate-500">
                           <span>{currentProject.shots.length} shots</span>
                           <span>Cập nhật: {new Date(currentProject.updatedAt).toLocaleString('vi-VN')}</span>
                       </div>
                    )}
                </div>

                <div className="">
                    {currentProject.shots.map((shot, index) => {
                        const isLastItem = index === currentProject.shots.length - 1;
                        
                        // Reference shots now need to point to the Active Variation
                        const availableReferenceShots = currentProject.shots
                            .slice(0, index)
                            .filter(s => s.imageVariations.length > 0)
                            .map(s => ({ id: s.id, shotNumber: s.shotNumber }));

                        return (
                            <div key={shot.id} className={!isLastItem ? 'mb-6' : ''}>
                                <ShotItem 
                                    shot={shot}
                                    projectIdea={currentProject.idea}
                                    onGenerateImage={handleGenerateImage}
                                    onEditImage={handleEditShotImage}
                                    onSelectVariation={handleSelectVariation}
                                    onUpdateShotDescription={handleUpdateShotDescription}
                                    onUpdateVisualPrompt={handleUpdateVisualPrompt}
                                    onGetSuggestions={handleGetSuggestionsForShot}
                                    onUpdateSettings={handleUpdateShotSettings}
                                    isRateLimited={rateLimitCooldown > 0}
                                    isApiBusy={isApiBusy}
                                    isApiThrottled={apiThrottle > 0}
                                    availableReferenceShots={availableReferenceShots}
                                    onAddShotAfter={handleAddShotAfter}
                                    onDeleteShot={handleInitiateDeleteShot}
                                />
                            </div>
                        );
                    })}
                </div>
            </div>
          </div>
        )}
      </main>

      {isShotTrashModalOpen && currentProject && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 animate-in fade-in"
          onClick={() => setIsShotTrashModalOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-2xl rounded-2xl border border-cinematic-700 bg-cinematic-900 shadow-2xl flex flex-col"
            style={{ maxHeight: '80vh' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center p-4 border-b border-cinematic-700 shrink-0">
                <h3 className="text-xl font-semibold text-white">Thùng rác cảnh quay</h3>
                <button onClick={() => setIsShotTrashModalOpen(false)} className="p-1 rounded-full hover:bg-cinematic-700 text-slate-400 hover:text-white">
                    <IconX />
                </button>
            </div>
            <div className="p-6 overflow-y-auto space-y-4">
                {(currentProject.trashedShots || []).length === 0 ? (
                    <p className="text-center text-slate-500 py-8">Thùng rác trống.</p>
                ) : (
                    (currentProject.trashedShots || []).map(shot => (
                        <div key={shot.id} className="flex items-center justify-between p-3 rounded-lg bg-cinematic-800 border border-cinematic-700/50">
                            <div className="flex items-center gap-3 min-w-0">
                                <span className="flex h-6 w-6 items-center justify-center rounded bg-cinematic-700 text-xs font-bold text-slate-400 shrink-0">
                                    {shot.shotNumber}
                                </span>
                                <p className="text-sm text-slate-300 truncate">{shot.description}</p>
                            </div>
                            <div className="flex items-center gap-2 shrink-0 ml-4">
                                <button onClick={() => handleRestoreShot(shot.id)} className="flex items-center gap-1.5 text-xs text-green-400 hover:text-white transition-colors p-2 rounded-md hover:bg-green-500/20" title="Phục hồi cảnh quay">
                                    <IconRestore />
                                </button>
                                <button onClick={() => handlePermanentlyDeleteShot(shot.id)} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-red-400 transition-colors p-2 rounded-md hover:bg-cinematic-700" title="Xóa vĩnh viễn">
                                    <IconTrash />
                                </button>
                            </div>
                        </div>
                    ))
                )}
            </div>
             {(currentProject.trashedShots || []).length > 0 && (
                <div className="flex justify-end p-4 border-t border-cinematic-700 shrink-0">
                    <button
                        onClick={handleEmptyTrash}
                        className="rounded-lg bg-red-600/90 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-600"
                    >
                        Dọn sạch thùng rác
                    </button>
                </div>
             )}
          </div>
        </div>
      )}
      
      {isProjectTrashModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 animate-in fade-in"
          onClick={() => setIsProjectTrashModalOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-2xl rounded-2xl border border-cinematic-700 bg-cinematic-900 shadow-2xl flex flex-col"
            style={{ maxHeight: '80vh' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center p-4 border-b border-cinematic-700 shrink-0">
                <h3 className="text-xl font-semibold text-white">Thùng rác dự án</h3>
                <button onClick={() => setIsProjectTrashModalOpen(false)} className="p-1 rounded-full hover:bg-cinematic-700 text-slate-400 hover:text-white">
                    <IconX />
                </button>
            </div>
            <div className="p-6 overflow-y-auto space-y-4">
                {trashedProjects.length === 0 ? (
                    <p className="text-center text-slate-500 py-8">Thùng rác trống.</p>
                ) : (
                    trashedProjects.map(project => (
                        <div key={project.id} className="flex items-center justify-between p-3 rounded-lg bg-cinematic-800 border border-cinematic-700/50">
                            <div className="flex items-center gap-3 min-w-0">
                                <span className="flex items-center justify-center rounded bg-cinematic-700 text-slate-400 shrink-0 p-2">
                                   <IconFilm/>
                                </span>
                                <p className="text-sm text-slate-300 truncate">{project.title}</p>
                            </div>
                            <div className="flex items-center gap-2 shrink-0 ml-4">
                                <button onClick={() => handleRestoreProject(project.id)} className="flex items-center gap-1.5 text-xs text-green-400 hover:text-white transition-colors p-2 rounded-md hover:bg-green-500/20" title="Phục hồi dự án">
                                    <IconRestore />
                                </button>
                                <button onClick={() => handlePermanentlyDeleteProject(project.id)} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-red-400 transition-colors p-2 rounded-md hover:bg-cinematic-700" title="Xóa vĩnh viễn">
                                    <IconTrash />
                                </button>
                            </div>
                        </div>
                    ))
                )}
            </div>
             {trashedProjects.length > 0 && (
                <div className="flex justify-end p-4 border-t border-cinematic-700 shrink-0">
                    <button
                        onClick={handleEmptyProjectTrash}
                        className="rounded-lg bg-red-600/90 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-600"
                    >
                        Dọn sạch thùng rác
                    </button>
                </div>
             )}
          </div>
        </div>
      )}

      {pendingShotDeletionId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 animate-in fade-in">
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-md rounded-2xl border border-cinematic-700 bg-cinematic-900 shadow-2xl p-6"
          >
            <h3 className="text-lg font-semibold text-white">Xác nhận</h3>
            <p className="mt-2 text-sm text-slate-400">
              Bạn có chắc chắn muốn chuyển cảnh này vào thùng rác không?
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={handleCancelDeleteShot}
                className="rounded-lg bg-cinematic-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-cinematic-600"
              >
                Hủy
              </button>
              <button
                onClick={handleConfirmDeleteShot}
                className="rounded-lg bg-red-600/90 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-600"
              >
                Chuyển vào thùng rác
              </button>
            </div>
          </div>
        </div>
      )}

      {/* NEW: Custom Confirm Dialog */}
      {confirmDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 animate-in fade-in" onClick={() => setConfirmDialog(null)}>
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-md rounded-2xl border border-cinematic-700 bg-cinematic-900 shadow-2xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-white">{confirmDialog.title}</h3>
            <p className="mt-2 text-sm text-slate-400">
              {confirmDialog.message}
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setConfirmDialog(null)}
                className="rounded-lg bg-cinematic-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-cinematic-600"
              >
                {confirmDialog.cancelLabel || 'Hủy'}
              </button>
              <button
                onClick={() => {
                  confirmDialog.onConfirm();
                  setConfirmDialog(null);
                }}
                className="rounded-lg bg-red-600/90 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-600"
              >
                {confirmDialog.confirmLabel || 'Xác nhận'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};

export default App;