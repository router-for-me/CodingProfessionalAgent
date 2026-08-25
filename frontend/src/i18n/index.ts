import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en.json'
import zh from './locales/zh-CN.json'

void i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zh },
    en: { translation: en },
  },
  lng: 'zh-CN',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
})

export default i18n
