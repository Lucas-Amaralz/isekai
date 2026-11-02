; Instalador do Isekai: tela de boas-vindas com a arte e sem perguntar "para quem" (sempre só para o usuário, sem administrador).
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customWelcomePage
  !insertmacro skipPageIfUpdated
  !define MUI_WELCOMEPAGE_TITLE "Bem-vindo ao Isekai"
  !define MUI_WELCOMEPAGE_TEXT "Um filme, uma série, a galera junta — e o som só do player.$\r$\n$\r$\nClique em Próximo para instalar. Não precisa de administrador, e daqui pra frente o Isekai se atualiza sozinho."
  !insertmacro MUI_PAGE_WELCOME
!macroend