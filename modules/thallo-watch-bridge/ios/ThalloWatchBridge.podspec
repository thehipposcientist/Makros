require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ThalloWatchBridge'
  s.version        = package['version']
  s.summary        = package['description']
  s.authors        = { 'Thallo' => 'team@thallo.app' }
  s.license        = 'MIT'
  s.homepage       = 'https://thallo.app'
  s.platforms      = { :ios => '14.0' }
  s.swift_version  = '5.4'
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift + WatchConnectivity.
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
  }

  s.source_files = "**/*.{h,m,swift}"
end
