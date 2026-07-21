(function(){

const STORAGE="LB_THEME";

/*==============================
   Cargar tema
==============================*/

let theme=localStorage.getItem(STORAGE);

if(!theme){

    theme="dark";

}

document.documentElement.setAttribute("data-theme",theme);

/*==============================
   Crear botón automáticamente
==============================*/

const button=document.createElement("button");

button.id="themeToggle";

button.innerHTML=theme==="dark"?"☀️":"🌙";

document.body.appendChild(button);

/*==============================
      Cambiar tema
==============================*/

button.onclick=function(){

    theme=document.documentElement.getAttribute("data-theme");

    if(theme==="dark"){

        theme="light";

        button.innerHTML="🌙";

    }else{

        theme="dark";

        button.innerHTML="☀️";

    }

    document.documentElement.setAttribute("data-theme",theme);

    localStorage.setItem(STORAGE,theme);

};

})();
