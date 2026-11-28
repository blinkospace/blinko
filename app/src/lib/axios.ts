import axios from 'axios';
import { RootStore } from '@/store/root';
import { UserStore } from '@/store/user';
import { getBlinkoEndpoint } from './blinkoEndpoint';
import { isBlinkoUrl } from './fileUrl';

// Create axios instance
const axiosInstance = axios.create({
  baseURL: '', // Base URL can be set as needed
  timeout: 5 * 60 * 1000, // 5 minutes for large file uploads
});

// Request interceptor
axiosInstance.interceptors.request.use(
  (config) => {
    // Get token from UserStore
    const userStore = RootStore.Get(UserStore);
    const token = userStore.tokenData.value?.token;
    
    // Attachment content can reference an external image. Only the configured
    // Blinko origin receives the user's bearer token.
    const endpoint = getBlinkoEndpoint('/');
    const target = new URL(config.url || '', new URL(config.baseURL || '', endpoint)).href;
    if (token && isBlinkoUrl(target, endpoint)) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    
    return config;
  },
  (error) => {
    console.error('[Client] Axios request error:', error);
    return Promise.reject(error);
  }
);

// Response interceptor
axiosInstance.interceptors.response.use(
  (response) => {
    return response;
  },
  (error) => {
    console.error('[Client] Axios response error:', error);
    
    // Handle 401 error (unauthorized)
    if (error.response && error.response.status === 401) {
      // You can handle token expiration logic here, such as redirecting to login page
      // window.location.href = '/signin';
    }
    
    return Promise.reject(error);
  }
);

export default axiosInstance;
