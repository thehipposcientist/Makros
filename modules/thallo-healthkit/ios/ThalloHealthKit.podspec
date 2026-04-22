Pod::Spec.new do |s|
  s.name           = 'ThalloHealthKit'
  s.version        = '1.0.0'
  s.summary        = 'HealthKit bridge for Thallo'
  s.homepage       = 'https://github.com/anthropics/expo-modules-core'
  s.license        = 'MIT'
  s.author         = 'Thallo'
  s.source         = { git: '' }
  s.static_framework = true
  s.platform       = :ios, '15.1'
  s.swift_version  = '5.4'
  s.source_files   = '*.swift'
  s.frameworks     = 'HealthKit'
  s.dependency 'ExpoModulesCore'
end
