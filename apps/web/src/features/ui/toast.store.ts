import { create } from 'zustand';

export interface ToastState {
  message: string;
  visible: boolean;
  show: (message: string) => void;
  hide: () => void;
}

let timer: ReturnType<typeof setTimeout> | undefined;

export const useToastStore = create<ToastState>((set) => ({
  message: '',
  visible: false,
  show: (message) => {
    if (timer) clearTimeout(timer);
    set({ message, visible: true });
    timer = setTimeout(() => set({ visible: false }), 4600);
  },
  hide: () => {
    if (timer) clearTimeout(timer);
    set({ visible: false });
  },
}));
