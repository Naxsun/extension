import React, { ReactElement, useState } from "react"
import { useHistory, useParams } from "react-router-dom"
import OnboardingImportMetamask from "./OnboardingImportMetamask"
import OnboardingVerifySeed from "./OnboardingVerifySeed"
import OnboardingSaveSeed from "./OnboardingSaveSeed"
import OnboardingAddWallet from "./OnboardingAddWallet"
import OnboardingInfoIntro from "./OnboardingInfoIntro"

export default function Onboarding(): ReactElement {
  const { startPage } = useParams<{ startPage: string }>()
  const history = useHistory()
  const [step, setStep] = useState(Math.floor(parseInt(startPage, 10)))

  return (
    <>
      {step === 0 && (
        <OnboardingInfoIntro
          triggerNextStep={() => {
            setStep(step + 1)
          }}
        />
      )}
      {step === 1 && (
        <OnboardingAddWallet
          openMetamaskImportScreen={() => {
            setStep(4)
          }}
        />
      )}
      {step === 2 && (
        <OnboardingSaveSeed
          triggerNextStep={() => {
            setStep(step + 1)
          }}
        />
      )}
      {step === 3 && (
        <OnboardingVerifySeed
          triggerPreviousStep={() => {
            setStep(step - 1)
          }}
        />
      )}
      {step === 4 && (
        <OnboardingImportMetamask onImported={() => history.push("/")} />
      )}
    </>
  )
}
