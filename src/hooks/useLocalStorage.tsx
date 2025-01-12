import { useAuth } from '@/Context/AuthContext';
import { useState } from 'react'

export function useLocalStorage<T>(key: string, initialValue: T) {
    const { session } = useAuth();
    const userId = session?.user?.id;
    
    // Create user-specific storage key
    const userKey = userId ? `${key}_${userId}` : key;
    
    // State to store our value
    const [storedValue, setStoredValue] = useState<T>(() => {
        try {
            const item = window.localStorage.getItem(userKey)
            return item ? JSON.parse(item) : initialValue
        } catch (error) {
            console.log(error)
            return initialValue
        }
    })

    // Return a wrapped version of useState's setter function that persists the new value to localStorage
    const setValue = (value: T | ((val: T) => T)) => {
        try {
            // Allow value to be a function so we have same API as useState
            const valueToStore = value instanceof Function ? value(storedValue) : value
            setStoredValue(valueToStore)
            window.localStorage.setItem(userKey, JSON.stringify(valueToStore))
        } catch (error) {
            console.log(error)
        }
    }

    return [storedValue, setValue] as const
}