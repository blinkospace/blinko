import { makeAutoObservable } from 'mobx';
import { Store } from './standard/base';
import { FileType } from '@/components/Common/Editor/type';
import { getBlinkoFileUrl } from '@/lib/blinkoEndpoint';
import { RootStore } from './root';
import { UserStore } from './user';

export interface AudioMetadata {
  coverUrl?: string;
  trackName?: string;
  albumName?: string;
  artists?: string[];
  previewUrl?: string;
}

export interface PlaylistTrack {
  file: FileType;
  metadata?: AudioMetadata;
  addedAt: number;
}

export class MusicManagerStore implements Store {
  sid = 'MusicManagerStore';
  private static instance: MusicManagerStore;
  private static audioInstance: HTMLAudioElement | null = null;

  constructor() {
    makeAutoObservable(this);
    if (MusicManagerStore.instance) {
      return MusicManagerStore.instance;
    }
    MusicManagerStore.instance = this;

    if (!MusicManagerStore.audioInstance) {
      const audio = new Audio();
      this.initAudio(audio);
    }
  }

  private _playlist: PlaylistTrack[] = [];
  private _currentTrackName: string = '';
  private _playMode: number = 0;

  get playlist(): PlaylistTrack[] {
    return this._playlist;
  }

  isPlaying = false;
  currentTime = 0;
  duration = 0;
  audioElement: HTMLAudioElement | null = null;
  showMiniPlayer = false;

  get playMode(): number {
    return this._playMode;
  }

  set playMode(value: number) {
    this._playMode = value;
  }

  get currentTrack(): PlaylistTrack | undefined {
    return this.playlist.find(track =>
      (track.metadata?.trackName || track.file.name) === this._currentTrackName
    );
  }

  get currentIndex(): number {
    return this.playlist.findIndex(track =>
      (track.metadata?.trackName || track.file.name) === this._currentTrackName
    );
  }

  initAudio(audio: HTMLAudioElement) {
    if (this.audioElement) {
      this.removeAudioEvents(this.audioElement);
    }

    if (MusicManagerStore.audioInstance) {
      const currentSrc = MusicManagerStore.audioInstance.src;
      const currentTime = MusicManagerStore.audioInstance.currentTime;
      const wasPlaying = !MusicManagerStore.audioInstance.paused;

      this.audioElement = MusicManagerStore.audioInstance;
    } else {
      this.audioElement = audio;
      MusicManagerStore.audioInstance = audio;
    }

    this.bindAudioEvents();
  }

  private removeAudioEvents(audio: HTMLAudioElement) {
    audio.removeEventListener('timeupdate', this.handleTimeUpdate);
    audio.removeEventListener('ended', this.handleEnded);
    audio.removeEventListener('loadedmetadata', this.handleLoadedMetadata);
    audio.removeEventListener('error', this.handleError);
  }

  private handleTimeUpdate = () => {
    this.currentTime = this.audioElement?.currentTime || 0;
  };

  private handleEnded = () => {
    this.isPlaying = false;
    this.playNext();
  };

  private handleLoadedMetadata = () => {
    if (this.audioElement && !isNaN(this.audioElement.duration) && isFinite(this.audioElement.duration)) {
      this.duration = this.audioElement.duration;
    } else {
      this.duration = 0;
    }
  };

  private handleError = (e: Event) => {
    console.error('play error:', e);
    this.isPlaying = false;
  };

  private bindAudioEvents() {
    if (!this.audioElement) return;

    this.audioElement.addEventListener('timeupdate', this.handleTimeUpdate);
    this.audioElement.addEventListener('ended', this.handleEnded);
    this.audioElement.addEventListener('loadedmetadata', this.handleLoadedMetadata);
    this.audioElement.addEventListener('error', this.handleError);
  }

  addToPlaylist(file: FileType, metadata?: AudioMetadata, playNow: boolean = false) {
    const trackName = metadata?.trackName || file.name;

    const exists = this.playlist.some(track =>
      (track.metadata?.trackName || track.file.name) === trackName
    );

    if (!exists) {
      const newTrack: PlaylistTrack = {
        file,
        metadata,
        addedAt: Date.now()
      };

      this._playlist = [...this.playlist, newTrack];
      this.showMiniPlayer = true;
    }

    if (playNow || !this.currentTrack) {
      this.playTrackByName(trackName);
    }
  }

  setPlaylist(files: FileType[], metadata: Record<string, AudioMetadata> = {}) {
    const newTracks = files.map(file => ({
      file,
      metadata: metadata[file.name],
      addedAt: Date.now()
    }));

    const uniqueTracks = this.mergePlaylist(this.playlist, newTracks);
    this._playlist = uniqueTracks;

    const currentTrackName = this._currentTrackName;
    const stillExists = uniqueTracks.some(track =>
      (track.metadata?.trackName || track.file.name) === currentTrackName
    );

    if (!stillExists) {
      this._currentTrackName = '';
    }

    this.showMiniPlayer = true;
  }

  private mergePlaylist(oldTracks: PlaylistTrack[], newTracks: PlaylistTrack[]): PlaylistTrack[] {
    const trackMap = new Map<string, PlaylistTrack>();

    oldTracks.forEach(track => {
      const key = track.metadata?.trackName || track.file.name;
      trackMap.set(key, track);
    });

    newTracks.forEach(track => {
      const key = track.metadata?.trackName || track.file.name;
      if (!trackMap.has(key)) {
        trackMap.set(key, track);
      }
    });

    return Array.from(trackMap.values());
  }

  removeFromPlaylist(trackName: string) {
    const newPlaylist = this.playlist.filter(track =>
      (track.metadata?.trackName || track.file.name) !== trackName
    );
    this._playlist = newPlaylist;

    if (this._currentTrackName === trackName) {
      if (newPlaylist.length > 0) {
        this.playNext();
      } else {
        this.closeMiniPlayer();
      }
    }
  }

  async playTrackByName(trackName: string) {
    const track = this.playlist.find(t =>
      (t.metadata?.trackName || t.file.name) === trackName
    );

    if (!track || !this.audioElement) return;

    this.audioElement.pause();
    this.isPlaying = false;
    this.duration = 0;
    this.currentTime = 0;

    this._currentTrackName = trackName;

    if (track.file.preview) {
      try {
        const audioUrl = getBlinkoFileUrl(track.file.preview, {
          token: RootStore.Get(UserStore).tokenData?.value?.token,
        });

        this.audioElement.src = audioUrl;

        try {
          await new Promise<void>((resolve, reject) => {
            const timeoutId = setTimeout(() => {
              resolve();
            }, 2000);

            this.audioElement!.addEventListener('loadedmetadata', () => {
              clearTimeout(timeoutId);
              if (this.audioElement && !isNaN(this.audioElement.duration) && isFinite(this.audioElement.duration)) {
                this.duration = this.audioElement.duration;
              }
              resolve();
            }, { once: true });

            this.audioElement!.addEventListener('error', (e) => {
              clearTimeout(timeoutId);
              reject(e);
            }, { once: true });
          });
        } catch (error) {
          console.error('Failed to load audio metadata:', error);
        }

        await this.audioElement.play();
        this.isPlaying = true;
        this.showMiniPlayer = true;
      } catch (error) {
        console.error('play error:', error);
        this.isPlaying = false;
      }
    }
  }

  async togglePlay() {
    if (!this.audioElement) {
      return;
    }

    try {
      if (this.isPlaying) {
        this.audioElement.pause();
        this.isPlaying = false;
      } else {
        if (!this.audioElement.src) {
          return;
        }

        if (this.audioElement.readyState < 2) {
          await new Promise((resolve) => {
            this.audioElement!.addEventListener('canplay', resolve, { once: true });
          });
        }

        await this.audioElement.play();
        this.isPlaying = true;
      }
    } catch (error) {
      this.isPlaying = false;
    }
  }

  playNext() {
    const currentIndex = this.currentIndex;
    let nextTrack: PlaylistTrack | undefined;

    switch (this.playMode) {
      case 1:
        nextTrack = this.currentTrack;
        break;
      case 2:
        const randomIndex = Math.floor(Math.random() * this.playlist.length);
        nextTrack = this.playlist[randomIndex];
        break;
      default:
        const nextIndex = (currentIndex + 1) % this.playlist.length;
        nextTrack = this.playlist[nextIndex];
    }

    if (nextTrack) {
      this.playTrackByName(nextTrack.metadata?.trackName || nextTrack.file.name);
    }
  }

  playPrevious() {
    const currentIndex = this.currentIndex;
    if (currentIndex === -1) return;

    let prevIndex = currentIndex - 1;
    if (prevIndex < 0) {
      prevIndex = this.playlist.length - 1;
    }

    const prevTrack = this.playlist[prevIndex];
    if (prevTrack) {
      this.playTrackByName(prevTrack.metadata?.trackName || prevTrack.file.name);
    }
  }

  seek(time: number) {
    if (this.audioElement) {
      this.audioElement.currentTime = time;
    }
  }

  togglePlayMode() {
    this._playMode = (this._playMode + 1) % 3;
  }

  closeMiniPlayer() {
    this.showMiniPlayer = false;
    if (this.audioElement) {
      this.audioElement.pause();
      this.isPlaying = false;
    }
    this._currentTrackName = '';
  }

  clearPlaylist() {
    this._playlist = [];
    this._currentTrackName = '';
    this.closeMiniPlayer();
  }
}
