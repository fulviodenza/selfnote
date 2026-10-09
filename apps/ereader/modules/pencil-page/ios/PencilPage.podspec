Pod::Spec.new do |s|
  s.name           = 'PencilPage'
  s.version        = '1.0.0'
  s.summary        = 'PencilKit writing surface for Selfnote eReader note pages'
  s.description    = 'Wraps PKCanvasView so blank exercise pages are written with the native ink pipeline instead of a WebView canvas.'
  s.author         = 'fulviodenza'
  s.homepage       = 'https://github.com/fulviodenza/selfnote'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => 'https://github.com/fulviodenza/selfnote.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,swift}'
end
