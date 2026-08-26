{
  "targets": [
    {
      "target_name": "process_tree",
      "sources": ["process_tree.c"],
      "defines": ["NAPI_VERSION=8", "WIN32_LEAN_AND_MEAN"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "RuntimeLibrary": "0",
          "AdditionalOptions!": ["-std:c++20"],
          "LanguageStandard_C": "stdc17"
        }
      }
    }
  ]
}
